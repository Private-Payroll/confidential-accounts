import { START_STOP } from './vault-operation.js';
import { aPrivatePaymentOut, anUnsetNewerSecret } from './vault-operation.test-support.js';
import { DEPOSIT_CLOCKS_MAY_DIFFER_MS, DEPOSIT_TIME_TO_LIVE_MS, type DepositInFlight, DepositLandedNotYetRecorded, DepositMayOutliveItsWindow, DepositNotAsBuilt, DepositNotSent, DepositNotYetSeen, DepositStartedElsewhere, DepositStillInFlight, MergeNotAsBuilt, MergeNotYetSeen, NotesMovedUnderAStep, type PaymentInFlight, PaymentLandedUnrecorded, PaymentNotAsBuilt, PaymentNotYetSeen, PaymentRefusedOnChain, PaymentStartedElsewhere, PaymentStillInFlight, PublicPaymentNotYetSeen, START_READ_STOP, type SecretReaderSources, StepOvertaken, VaultNotReadHere, VaultNotTheCompanys, type VaultService, VaultStartOwed, checkWhatThisBrowserDeposited, checkWhatThisBrowserSent, createCompanyVault, depositIntoCompanyVault, journalledDepositLandsBy, mergeNotesInCompanyVault, openCompanyVaultPool, payPrivatelyFromCompanyVault, payPubliclyFromCompanyVault, sayWhatTheCheckFound, settleDepositInFlight, settlePaymentInFlight } from './vault-operation.js';
import { DepositCoinAlreadyMade, depositNonceAt } from '../../../src/midnight/deposit-nonce.js';
import { type Hex, newWrappingKeypair, toHex } from '../../../src/core/crypto.js';
import { type Kept, inFlightInMemory as inFlightInMemoryRecords } from './in-flight-on-this-device.js';
import { MemorySealedPoolStore, SealedNotePool, openPool, sealPool } from '../../../src/midnight/vault-pool.js';
import { PaymentJournalInStore } from '../../../src/midnight/vault-journal.js';
import type { PrivatePaymentOnTheWire, PrivatePaymentOrderOnTheWire } from '../../../src/midnight/private-payment-wire.js';
import { ReadRanOutOfTime, SERVICE_READ_BOUND_MS } from './read-bound.js';
import { type SealedCompanyRecord, type WireRecord, signCompanyFiling } from '../../../src/midnight/sealed-record-wire.js';
import { VaultAskFailed, type VaultBuilderClient, type VaultOnChainOnTheWire, vaultBuilderOver } from './vault-worker-client.js';
import { answerVaultAsk, creatingTransactionOfNote } from './vault-worker-entry.js';
import { changeAfterSpending, mergedNoteOf } from '../../../src/midnight/vault-recovery.js';
import { coinsKeptOnThisDevice } from './vault-coins-kept-here.js';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { confirmPayment } from './vault-builder.js';
import { currentDepositNonceKey, openNonceSecrets, recordsKeypairFrom, startNonceSecret } from '../../../src/midnight/company-nonce-secret.js';
import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { nonceCircuitsFrom } from '../../../src/midnight/vault-coin-nonces.js';
import { openVaultInfo, sealVaultInfo } from '../../../src/midnight/vault-info-record.js';
import { proposalsKeptInATest } from './a-vaults-start-proposals.test-support.js';
import { VaultSecretBeingChanged, recordsReaderOf } from './deposit-on-device.js';
import { sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import { seatBarOf, signRecordsKey } from 'midnight-identity/profile/records-key';
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import { vaultNoteCommitment } from '../../../src/midnight/note-index.js';
import { ACCOUNT, ADAS, CURRENT_CHAIN, type ChainBehind, LABEL, PARAMS, type TestView, VAULT, aServiceThatLies, adasDirectory, builder, chains, committee, eventsOfAPayment, filedAlready, held, hereAndThere, inFlightInMemory, indexerOf, newestSecretIn, nothingToCheck, oneKey, ownOnChain, pacing, paymentEvents, readOnTheDevice, serviceFrom, startDoors, theServiceNeverAsked, view, walletKey, walletRead, walletReadsTheVault, wireOfCoin } from './vault-operation.test-support.js';


describe('CREATING A VAULT', () => {
  const create = (doors: Awaited<ReturnType<typeof filedAlready>> | ReturnType<typeof startDoors>, service: VaultService, log: string[], over: Partial<Parameters<typeof createCompanyVault>[0]> = {}, resume?: string) =>
    createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service, builder: builder(log), ...over }, resume as never);

  it('IS BUILT HELD BY THE COMPANY\'S COMMITTEE, SENT, READ AS IT WAS BORN, AND STARTED - WITH NO TEMPORARY KEY AND NO HAND-OVER', async () => {
    const log: string[] = [];
    const done = await create(await filedAlready(), serviceFrom([held], log), log);
    /* RED WHEN: the press ends before the chain shows the vault started. */
    expect(done).toEqual({ vault: VAULT, state: 'started' });
    /*
     * RED WHEN: a temporary key is made or kept, a hand-over is built or sent, the vault is held by anything but the
     * committee, or the start goes on before this device has read the vault as it was born.
     */
    expect(log).toEqual([`build vault held by ${walletKey(0x11).slice(0, 2)} at 1`, 'sent deploy', 'read the deploy at the wallet\'s indexer against 1 key(s)',
      /* The start reads both contracts at one block here, before the adoption and again with the secret read back. */
      'read the block here', 'read the block here']);
  });

  /* RED WHEN: the vault carried on is whatever address the service answers the deploy with. */
  it('A DEPLOY ANSWERED WITH ANOTHER VAULT THAN THE ONE SENT IS NOT CARRIED ON WITH', async () => {
    const log: string[] = [];
    const service = serviceFrom([held], log, { deploy: async () => { log.push('sent deploy'); return { vault: 'ef'.repeat(32), txRef: 'd' }; } });
    const e = await create(await filedAlready(), service, log).catch((x) => x);
    expect(e).toBeInstanceOf(VaultStartOwed);
    expect(e.vault).toBe(VAULT);
    expect(e.message).toMatch(/answered with another vault than the one this device sent/);
    expect(log.filter((l) => l.startsWith('read'))).toEqual([]);
  });

  it('A NEW VAULT IS BORN HELD BY THE ACCOUNT\'S COMMITTEE AS THE SIGNER\'S OWN WALLET READS IT, A KEY NO ROSTER ENTRY NAMES WITH IT, WHATEVER THE SERVICE REPORTS', async () => {
    const log: string[] = [];
    /* The super admins hold the account with a board member's key beside a signer's; the service reports no committee at all. */
    const board = { onChain: async (v: string) => ({ holders: { ...(await walletReadsTheVault.onChain(v)).holders,
      committee: [{ tag: 'schnorr', value: walletKey(0x11) }, { tag: 'schnorr', value: walletKey(0x99) }], threshold: 2 } }) };
    const service = serviceFrom([held], log, { keys: async () => ({ committee: null, why: 'not everybody has given a key.', readers: [] }) });
    await create(startDoors(), service, log, board).catch(() => undefined);
    /*
     * RED WHEN: the committee a vault is born held by is the service's, or is compared with the service's or the roster's -
     * a company whose super admins hold a key no signer does could then build no vault.
     */
    expect(log[0]).toBe(`build vault held by ${walletKey(0x11).slice(0, 2)},${walletKey(0x99).slice(0, 2)} at 2`);
  });

  it('NO VAULT HELD BY A COMMITTEE THE ONE INSTALL RULE REFUSES', async () => {
    const log: string[] = [];
    const twice = { committee: [{ tag: 'schnorr', value: walletKey(0x11) }, { tag: 'schnorr', value: walletKey(0x11) }], threshold: 2 };
    const service = serviceFrom([], log, { keys: async () => ({ committee: twice, why: null, readers: [] }) });
    const wallet = { onChain: async (v: string) => ({ holders: { ...(await walletReadsTheVault.onChain(v)).holders, ...twice } }) };
    /* RED WHEN: a vault is built for a committee that lists one key twice. */
    await expect(create(startDoors(), service, log, wallet)).rejects.toThrow(/are the same key/);
    expect(log).toEqual([]);
  });

  it('A DEPLOY THAT MAY HAVE LANDED IS A FAILURE NAMING THE VAULT', async () => {
    const log: string[] = [];
    const service = serviceFrom([], log, { deploy: async () => { throw new Error('the node did not answer'); } });
    const e = await create(startDoors(), service, log).catch((x) => x);
    /* RED WHEN: a deploy that may have landed is lost, or reported as nothing sent. */
    expect(e).toBeInstanceOf(VaultStartOwed);
    expect(e.vault).toBe(VAULT);
    expect(e.message).toMatch(/may have been sent \(the node did not answer\)/);
  });

  it('A DEPLOY REFUSED BEFORE IT WAS SENT SAYS WHY, AND NOTHING ELSE HAPPENS', async () => {
    const log: string[] = [];
    const service = serviceFrom([], log, {
      deploy: async () => { throw Object.assign(new Error('refused. Nothing was sent.'), { nothingWasSent: true }); },
    });
    await expect(create(startDoors(), service, log)).rejects.toThrow('refused. Nothing was sent.');
    expect(log).toEqual([`build vault held by ${walletKey(0x11).slice(0, 2)} at 1`]);
  });

  it('A VAULT THAT NEVER APPEARS, OR A CHAIN READ THAT THROWS, IS NEVER REPORTED CREATED, AND NAMES THE VAULT', async () => {
    const absent = await create(startDoors(), serviceFrom([view({ onChain: false })], []), []).catch((x) => x);
    expect(absent).toBeInstanceOf(VaultStartOwed);
    expect(absent.message).toMatch(/the chain has not shown it yet/);
    /* RED WHEN: a read of the chain that throws after the vault was sent escapes as a plain error that does not name the vault. */
    const asked = { n: 0 };
    const service = theServiceNeverAsked({ service: serviceFrom([], []) }, asked).service;
    chains.set(CURRENT_CHAIN, async () => { throw new Error('the indexer did not answer'); });
    const e = await create(startDoors(), service, []).catch((x) => x);
    expect(e).toBeInstanceOf(VaultStartOwed);
    expect(e.vault).toBe(VAULT);
    expect(e.message).toMatch(/the chain could not be read for it on this device \(this device could not read the vault from the chain \(the indexer did not answer\)/);
    /* RED WHEN: the vault just sent is read from the service's answer rather than on this device. */
    expect(asked.n).toBe(0);
  });

  it('A VAULT NOT BORN HELD IS NEITHER ADOPTED NOR SET UP, AND ONE WHOSE DEPLOY CANNOT BE READ IS NOT EITHER', async () => {
    const log: string[] = [];
    const doors = await filedAlready();
    const notBorn = { ...builder(log), vaultAsDeployed: async () => ({ refusal: 'this is not a vault this company can use: held by other keys. Nothing was sent.' }) };
    /* RED WHEN: this device adopts or sets up a vault without reading it as it was born, or past what that read refused. */
    const e = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: notBorn }, VAULT)
      .catch((x) => x);
    expect(e).toBeInstanceOf(VaultNotTheCompanys);
    expect(e.message).toBe('this is not a vault this company can use: held by other keys. This vault is not set up and no money is put '
      + 'into it; create a new vault. Nothing was sent.');
    /* RED WHEN: a vault is carried on with when this device cannot read its deploy itself, on anybody's word. */
    const { vaultAsDeployed: _cannot, ...cannotRead } = builder(log);
    const none = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: cannotRead }, VAULT)
      .catch((x) => x);
    expect(none).toBeInstanceOf(VaultNotTheCompanys);
    expect(none.message).toMatch(/cannot read how this vault was created/);
    /* RED WHEN: the deploy is read somewhere other than the indexer the person's own wallet names, or anywhere when it names none. */
    const noIndexer = await create(doors, serviceFrom([held], log), log, { indexer: async () => null }, VAULT).catch((x) => x);
    expect(noIndexer).toBeInstanceOf(VaultStartOwed);
    expect(noIndexer.message).toMatch(/did not say which indexer it reads the chain through/);
    expect(log.filter((l) => l === 'read the block here' || l.startsWith('read the deploy'))).toEqual([]);
    /* RED WHEN: a wallet that stops naming its indexer once the vault is seen has its deploy read anywhere else. */
    let seen = false;
    const seenThenSilent = { ...builder(log), vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => { seen = true; return readOnTheDevice(i); } };
    const indexer = async () => (seen ? null : walletReadsTheVault.indexer());
    const silent = await create(doors, serviceFrom([held], log), log, { builder: seenThenSilent, indexer }, VAULT).catch((x) => x);
    expect(silent).toBeInstanceOf(VaultStartOwed);
    expect(silent.message).toMatch(/did not say which indexer it reads the chain through, so this device cannot read how the vault was created/);
    expect(log.filter((l) => l.startsWith('read the deploy'))).toEqual([]);
  });

  it('a resume for a vault the chain shows started reads it as it was born and finishes without building anything', async () => {
    const log: string[] = [];
    await expect(create(await filedAlready(), serviceFrom([held], log), log, {}, VAULT)).resolves.toEqual({ vault: VAULT, state: 'started' });
    expect(log).toEqual(['read the deploy at the wallet\'s indexer against 1 key(s)', 'read the block here', 'read the block here']);
  });

  describe('A START IS JUDGED AND BUILT ON ONE BLOCK THIS DEVICE READ AT THE INDEXER THE PERSON\'S OWN WALLET NAMES', () => {
    /** A builder whose read of one block finds nothing `behind` times before it finds the vault and the account. */
    const lagging = (log: string[], behind: number) => {
      const b = builder(log);
      let left = behind;
      return {
        ...b,
        chainAtOneBlock: async (i: Parameters<VaultBuilderClient['chainAtOneBlock']>[0]) => {
          if (left > 0) {
            left -= 1;
            log.push('the wallet\'s indexer does not show it yet');
            return null;
          }
          return b.chainAtOneBlock(i);
        },
      };
    };

    it('THE START\'S STANDING IS READ FROM THE BLOCK THIS DEVICE READ, AND THE SERVICE IS NEVER ASKED FOR ITS OWN', async () => {
      const log: string[] = [];
      const asked: string[] = [];
      const judged: string[] = [];
      const b = builder(log);
      const judging = { ...b, startStanding: async (i: Parameters<VaultBuilderClient['startStanding']>[0]) => {
        judged.push(`${i.account} ${i.vaultState} ${i.accountState}`);
        return b.startStanding(i);
      } };
      const done = await create(await filedAlready(), aServiceThatLies(serviceFrom([held], log), asked), log, { builder: judging }, VAULT);
      expect(done).toEqual({ vault: VAULT, state: 'started' });
      /* RED WHEN: the start asks the company's service for its block, which may be another chain's or a made-up one. */
      expect(asked).toEqual([]);
      /* RED WHEN: the start is judged on any block but the one read here, or on an account other than the one the wallet reads. */
      expect(judged).toEqual([`${ACCOUNT} V A`, `${ACCOUNT} V A`]);
    });

    it('WHILE THE WALLET\'S INDEXER DOES NOT YET SHOW THE VAULT AND THE ACCOUNT, THE START WAITS AND CARRIES ON', async () => {
      const log: string[] = [];
      const asked: string[] = [];
      const done = await create(await filedAlready(), aServiceThatLies(serviceFrom([held], log), asked), log, { builder: lagging(log, 2) }, VAULT);
      /* RED WHEN: an indexer behind the service stops the start at once, as a read that failed. */
      expect(done).toEqual({ vault: VAULT, state: 'started' });
      expect(log.filter((l) => l.startsWith('the wallet') || l.startsWith('read the block'))).toEqual([
        'the wallet\'s indexer does not show it yet', 'the wallet\'s indexer does not show it yet', 'read the block here', 'read the block here',
      ]);
      /* RED WHEN: the service's block is read while the wallet's indexer is behind. */
      expect(asked).toEqual([]);
    });

    it('A WALLET THAT STOPS NAMING ITS INDEXER STOPS THE START AT ONCE, NAMING THE VAULT, AND THE SERVICE IS NOT ASKED IN ITS PLACE', async () => {
      const log: string[] = [];
      const asked: string[] = [];
      /* The wallet names its indexer until the vault and the account are read for their circuits, and names none after. */
      let circuitsRead = false;
      const b = builder(log);
      const reading = { ...b, vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => {
        if (i.account !== undefined) circuitsRead = true;
        return b.vaultOnChain(i);
      } };
      const indexer = async () => (circuitsRead ? null : walletReadsTheVault.indexer());
      const e = await create(await filedAlready(), aServiceThatLies(serviceFrom([held], log), asked), log, { indexer, builder: reading }, VAULT).catch((x) => x);
      /* RED WHEN: a wallet that names no indexer is waited on as an indexer that is behind, or is taken as any indexer. */
      expect(e).toBeInstanceOf(VaultStartOwed);
      expect(e.vault).toBe(VAULT);
      expect(e.message).toMatch(/your wallet did not say which indexer it reads the chain through, so this device cannot read where its start stands\./u);
      expect(log.filter((l) => l.startsWith('read the block'))).toEqual([]);
      expect(asked).toEqual([]);
    });

    it('A READ OF THE BLOCK THAT FAILS STOPS THE START AT ONCE, NAMING THE VAULT AND WHY, WITHOUT WAITING', async () => {
      const log: string[] = [];
      const asked: string[] = [];
      let tries = 0;
      const failing = { ...builder(log), chainAtOneBlock: async () => { tries += 1; throw new Error('the indexer refused the query'); } };
      const e = await create(await filedAlready(), aServiceThatLies(serviceFrom([held], log), asked), log, { builder: failing }, VAULT).catch((x) => x);
      /* RED WHEN: a read that fails is waited on as an indexer that is behind, or its reason is lost. */
      expect(e).toBeInstanceOf(VaultStartOwed);
      expect(e.vault).toBe(VAULT);
      expect(e.message).toMatch(/this device could not read the chain at one block \(the indexer refused the query\)\./u);
      expect(tries).toBe(1);
      expect(asked).toEqual([]);
      /* RED WHEN: the stop does not say which read failed, so the wallet's stop line cannot name it. */
      expect(e.stoppedAt).toBe(START_READ_STOP.chainUnread);
    });

    /** A real pace: ten minutes asked every six seconds, with sleeps that pass the time they would take on a clock kept here. */
    const aRealPace = () => {
      const clock = { ms: 0 };
      return { clock, pace: { waitMs: 10 * 60_000, everyMs: 6_000, sleep: async (ms: number) => { clock.ms += ms; } } };
    };

    it('A READ OF THE BLOCK THAT RUNS OUT OF TIME IS ASKED AGAIN, AND THE START CARRIES ON WHEN IT ANSWERS', async () => {
      const log: string[] = [];
      const asked: string[] = [];
      const b = builder(log);
      let reads = 0;
      let ranOut = 0;
      const once = { ...b, chainAtOneBlock: async (i: Parameters<VaultBuilderClient['chainAtOneBlock']>[0]) => {
        reads += 1;
        if (reads === 2) { ranOut += 1; throw new ReadRanOutOfTime('The network (chain-at-one-block)'); }
        return b.chainAtOneBlock(i);
      } };
      const { pace } = aRealPace();
      const done = await create(await filedAlready(), aServiceThatLies(serviceFrom([held], log), asked), log, { ...pace, builder: once }, VAULT);
      /* RED WHEN: a read that ran out of time stops the start as a read that failed, naming twenty seconds. */
      expect(done).toEqual({ vault: VAULT, state: 'started' });
      expect(ranOut).toBe(1);
      /* RED WHEN: the read that ran out is not asked again: the one read is tried twice, the others once. */
      expect(reads).toBe(3);
      expect(asked).toEqual([]);
    });

    it('A READ OF THE BLOCK THAT RUNS OUT OF TIME EVERY TIME ENDS THE START WITHIN ITS WAIT, NAMING THE VAULT, AND NOTHING IS SENT', async () => {
      const log: string[] = [];
      const asked: string[] = [];
      const { clock, pace } = aRealPace();
      let reads = 0;
      const never = { ...builder(log), chainAtOneBlock: async () => {
        reads += 1;
        clock.ms += SERVICE_READ_BOUND_MS;
        throw new ReadRanOutOfTime('The network (chain-at-one-block)');
      } };
      const e = await create(await filedAlready(), aServiceThatLies(serviceFrom([held], log), asked), log, { ...pace, builder: never }, VAULT)
        .catch((x) => x);
      /* RED WHEN: a wait that runs out escapes as a read that failed, rather than a start to finish that names the vault. */
      expect(e).toBeInstanceOf(VaultStartOwed);
      expect(e.vault).toBe(VAULT);
      /* RED WHEN: a chain never read is said to be behind, or the stop does not say a read failed. */
      expect(e.message).toMatch(/this device could not read the chain in time: no read answered within 20 seconds\./u);
      expect(e.message).not.toMatch(/has not shown it/u);
      expect(e.stoppedAt).toBe(START_READ_STOP.chainUnread);
      /* RED WHEN: reads that run out of time are each counted as one pause, stretching the wait past its ten minutes. */
      expect(clock.ms).toBeLessThanOrEqual(pace.waitMs);
      /* RED WHEN: the start gives up before it has waited, after the first read that ran out. */
      expect(reads).toBeGreaterThan(1);
      expect(asked).toEqual([]);
      expect(log.filter((l) => l.startsWith('sent'))).toEqual([]);
    });

    /** A builder whose read of the vault, with the account named or without, runs out of time once and then answers. */
    const vaultReadRunsOutOnce = (log: string[], withAccount: boolean) => {
      const b = builder(log);
      const ran = { out: 0, reads: 0 };
      const once = { ...b, vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => {
        if ((i.account !== undefined) === withAccount) {
          ran.reads += 1;
          if (ran.out === 0) { ran.out += 1; throw new ReadRanOutOfTime('The network (vault-on-chain)'); }
        }
        return b.vaultOnChain(i);
      } };
      return { ran, builder: once };
    };

    it('A READ OF THE VAULT AS IT WAS BORN THAT RUNS OUT OF TIME IS ASKED AGAIN, AND THE START CARRIES ON', async () => {
      const log: string[] = [];
      const { ran, builder: once } = vaultReadRunsOutOnce(log, false);
      const done = await create(await filedAlready(), serviceFrom([held], log), log, { ...aRealPace().pace, builder: once }, VAULT);
      /* RED WHEN: a read of the vault as it was born that ran out of time stops the start at once, as a read that failed. */
      expect(done).toEqual({ vault: VAULT, state: 'started' });
      expect(ran).toMatchObject({ out: 1 });
      expect(ran.reads).toBeGreaterThan(1);
    });

    it('A READ OF THE VAULT\'S CIRCUITS THAT RUNS OUT OF TIME IS ASKED AGAIN, AND THE START CARRIES ON', async () => {
      const log: string[] = [];
      const { ran, builder: once } = vaultReadRunsOutOnce(log, true);
      const done = await create(await filedAlready(), serviceFrom([held], log), log, { ...aRealPace().pace, builder: once }, VAULT);
      /* RED WHEN: a read of the vault's circuits that ran out of time stops the start at once, as a read that failed. */
      expect(done).toEqual({ vault: VAULT, state: 'started' });
      expect(ran).toMatchObject({ out: 1 });
      expect(ran.reads).toBeGreaterThan(1);
    });

    /** A builder whose read of how the vault was deployed runs out of time `times` times, each passing twenty seconds on `clock`, and then answers. */
    const deployReadRunsOut = (log: string[], times: number, clock?: { ms: number }) => {
      const b = builder(log);
      const ran = { out: 0, reads: 0 };
      const slow = { ...b, vaultAsDeployed: async (i: Parameters<NonNullable<VaultBuilderClient['vaultAsDeployed']>>[0]) => {
        ran.reads += 1;
        if (ran.out < times) {
          ran.out += 1;
          if (clock !== undefined) clock.ms += SERVICE_READ_BOUND_MS;
          throw new ReadRanOutOfTime('The network (vault-as-deployed)');
        }
        return b.vaultAsDeployed!(i);
      } };
      return { ran, builder: slow };
    };

    it('A READ OF HOW THE VAULT WAS DEPLOYED THAT RUNS OUT OF TIME IS ASKED AGAIN, AND THE START CARRIES ON', async () => {
      const log: string[] = [];
      const { ran, builder: once } = deployReadRunsOut(log, 1);
      const done = await create(await filedAlready(), serviceFrom([held], log), log, { ...aRealPace().pace, builder: once }, VAULT);
      /* RED WHEN: a read of how the vault was deployed that ran out of time stops the start at once, rather than being asked again. */
      expect(done).toEqual({ vault: VAULT, state: 'started' });
      expect(ran.out).toBe(1);
      expect(ran.reads).toBeGreaterThan(1);
    });

    it('A READ OF HOW THE VAULT WAS DEPLOYED THAT RUNS OUT OF TIME EVERY TIME ENDS THE START WITHIN ITS WAIT, AS A CHAIN NOT READ, AND NOTHING IS SENT', async () => {
      const log: string[] = [];
      const asked: string[] = [];
      const { clock, pace } = aRealPace();
      const { ran, builder: never } = deployReadRunsOut(log, Number.POSITIVE_INFINITY, clock);
      const e = await create(await filedAlready(), aServiceThatLies(serviceFrom([held], log), asked), log, { ...pace, builder: never }, VAULT)
        .catch((x) => x);
      expect(e).toBeInstanceOf(VaultStartOwed);
      expect(e.vault).toBe(VAULT);
      /* RED WHEN: a wait in which every read of how the vault was deployed ran out stops without saying the chain was not read, so the wallet cannot name it. */
      expect(e.stoppedAt).toBe(START_READ_STOP.chainUnread);
      expect(e.message).toMatch(/this device could not read the chain in time: no read answered within 20 seconds\./u);
      /* RED WHEN: reads of how the vault was deployed that run out of time are each counted as one pause, stretching the wait past its ten minutes. */
      expect(clock.ms).toBeLessThanOrEqual(pace.waitMs);
      expect(ran.reads).toBeGreaterThan(1);
      expect(asked).toEqual([]);
      expect(log.filter((l) => l.startsWith('sent'))).toEqual([]);
    });

    it('A STANDING THE VAULT WORKER CANNOT WORK OUT STOPS THE START, NAMING THE VAULT AND WHY', async () => {
      const log: string[] = [];
      const broken = { ...builder(log), startStanding: async () => { throw new Error('the account\'s state could not be read'); } };
      const e = await create(await filedAlready(), serviceFrom([held], log), log, { builder: broken }, VAULT).catch((x) => x);
      /* RED WHEN: the worker's failure reaches the page as a plain refusal that loses which vault was sent. */
      expect(e).toBeInstanceOf(VaultStartOwed);
      expect(e.vault).toBe(VAULT);
      expect(e.message).toMatch(/where its start stands could not be worked out on this device \(the account's state could not be read\)\./u);
      /* RED WHEN: the stop does not say which read failed, so the wallet's stop line cannot name it. */
      expect(e.stoppedAt).toBe(START_READ_STOP.standingUnread);
    });

    it('AN INDEXER THAT NEVER SHOWS THEM IS THE START NOT FINISHED, NAMING THE VAULT, AND NOTHING IS SENT', async () => {
      const log: string[] = [];
      const asked: string[] = [];
      const e = await create(await filedAlready(), aServiceThatLies(serviceFrom([held], log), asked), log, { builder: lagging(log, 99) }, VAULT)
        .catch((x) => x);
      /* RED WHEN: a wait that runs out escapes as a read that failed, rather than a start to finish that names the vault. */
      expect(e).toBeInstanceOf(VaultStartOwed);
      expect(e.vault).toBe(VAULT);
      expect(e.message).toMatch(/the chain your wallet reads has not shown it and your company's account yet\./u);
      /* RED WHEN: the start gives up before it has waited, or the service is asked in the indexer's place. */
      expect(log.filter((l) => l.startsWith('the wallet'))).toHaveLength(3);
      expect(asked).toEqual([]);
      expect(log.filter((l) => l.startsWith('sent'))).toEqual([]);
    });
  });

  describe('A START NEVER GOES ON WITH A VAULT OR AN ACCOUNT WHOSE CIRCUITS ARE NOT THE ONES THIS APP WAS BUILT WITH', () => {
    /*
     * The vault as this device reads it, with what the read says of the circuits; the company's account's are said only
     * when the read names the account, as the worker says them.
     */
    const readingCircuits = (log: string[], said: { circuits?: unknown; accountCircuits?: unknown }) => ({
      ...builder(log),
      vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => {
        const { accountCircuits, ...read } = (await readOnTheDevice(i)) as VaultOnChainOnTheWire & { accountCircuits?: unknown };
        const circuits = 'circuits' in said ? { circuits: said.circuits } : {};
        const account = i.account === undefined ? {} : { accountCircuits: 'accountCircuits' in said ? said.accountCircuits : accountCircuits };
        return { ...read, ...circuits, ...account } as never;
      },
    });
    const starting = (log: string[], said: { circuits?: unknown; accountCircuits?: unknown }) =>
      filedAlready().then((doors) => create(doors, serviceFrom([held], log), log, { builder: readingCircuits(log, said) }, VAULT).catch((x) => x));

    it('A VAULT WHOSE CIRCUITS ARE NOT THIS APP\'S, OR WHOSE READ DOES NOT SAY, IS NOT STARTED', async () => {
      const log: string[] = [];
      const e = await starting(log, { circuits: { circuit: 'withdraw', why: 'the vault\'s withdraw circuit is not the one this app was built with.' } });
      /* RED WHEN: a start goes on with a vault this app cannot prove for, or its refusal does not name the vault. */
      expect(e).toBeInstanceOf(VaultStartOwed);
      expect(e.vault).toBe(VAULT);
      expect(e.message).toMatch(/the vault's withdraw circuit is not the one this app was built with\. If the company's super admins moved it to a newer build.* Nothing was sent\./u);
      /* RED WHEN: the start reads where it stands, to raise or approve anything, before the read that refuses. */
      expect(log.filter((l) => l.startsWith('read the block'))).toEqual([]);
      const unsaid: string[] = [];
      const quiet = await starting(unsaid, { circuits: undefined });
      /* RED WHEN: a read that does not say whether the vault's circuits are this app's is taken as saying they are. */
      expect(quiet).toBeInstanceOf(VaultStartOwed);
      expect(quiet.message).toMatch(/did not say whether the vault's circuits are the ones this app was built with/u);
    });

    it('A VAULT NOT YET ADOPTED, ON AN ACCOUNT WHOSE CIRCUITS ARE NOT THIS APP\'S, IS REFUSED BEFORE ITS ADOPTION IS RAISED', async () => {
      const log: string[] = [];
      const not = { circuit: 'approve', why: 'the account\'s approve circuit is not the one this app was built with.' };
      /* The vault as the chain holds it before its adoption is raised: nothing proposed, approved or carried out. */
      const notAdopted = {
        ...readingCircuits(log, { accountCircuits: not }),
        startStanding: async () => ({ standing: {
          adopted: false, removals: 0,
          adoption: { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32), open: false, approvals: 0, needed: 1, stale: false, approvedHere: false },
        } }),
        governedCall: async () => { log.push('built a step of the adoption'); throw new Error('stop here'); },
      };
      const e = await create(await filedAlready(), serviceFrom([held], log), log, { builder: notAdopted }, VAULT).catch((x) => x);
      /* RED WHEN: the adoption is raised, approved or carried out for a vault on an account this app cannot prove for. */
      expect(e).toBeInstanceOf(VaultStartOwed);
      expect(e.message).toMatch(/the account's approve circuit is not the one this app was built with\..* Nothing was sent\./u);
      expect(log.filter((l) => l.startsWith('built a step') || l.startsWith('read the block') || l.startsWith('sent'))).toEqual([]);
    });

    it('A COMPANY ACCOUNT WHOSE CIRCUITS ARE NOT THIS APP\'S, OR ARE NOT READ, IS NOT STARTED ON', async () => {
      const log: string[] = [];
      const e = await starting(log, { accountCircuits: { circuit: 'approve', why: 'the account\'s approve circuit is not the one this app was built with.' } });
      /* RED WHEN: a start reads the vault without the company's account, or goes on with an account this app cannot prove for. */
      expect(e).toBeInstanceOf(VaultStartOwed);
      expect(e.message).toMatch(/the account's approve circuit is not the one this app was built with\..* Nothing was sent\./u);
      expect(log.filter((l) => l.startsWith('read the block'))).toEqual([]);
      const unsaid: string[] = [];
      const quiet = await starting(unsaid, { accountCircuits: undefined });
      /* RED WHEN: an account read that does not say is taken as this app's. */
      expect(quiet).toBeInstanceOf(VaultStartOwed);
      expect(quiet.message).toMatch(/did not say whether the company's account's circuits are the ones this app was built with/u);
    });

    it('A VAULT AND AN ACCOUNT BOTH OF THIS APP\'S, READ WITH THE ACCOUNT, ARE STARTED', async () => {
      const log: string[] = [];
      /* RED WHEN: the start's read leaves the company's account out, so its circuits are never said and every start is refused. */
      await expect(starting(log, {})).resolves.toEqual({ vault: VAULT, state: 'started' });
    });
  });

  it('A START REFUSES TO GO ON PAST ITS ADOPTION WITH A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER\'S OWN WALLET READS IT', async () => {
    const log: string[] = [];
    const doors = await filedAlready();
    const before = await doors.records('nonce-secret').versions(VAULT);
    const unadopted = { ...walletReadsTheVault, onChain: async (v: string) => ({ ...(await walletReadsTheVault.onChain(v)), holders: { ...(await walletReadsTheVault.onChain(v)).holders, adoptedVaults: [] } }) };
    const e = await createCompanyVault({ ...pacing, ...unadopted, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: builder(log) }, VAULT)
      .catch((x: Error) => x);
    /* RED WHEN: a start opens the pool or sets a secret for a vault the service's rows say was adopted and the account's own set does not hold. */
    expect(e).toBeInstanceOf(VaultStartOwed);
    expect((e as Error).message).toMatch(/not one your company's account has adopted/);
    expect(await doors.records('nonce-secret').versions(VAULT)).toEqual(before);
  });

  it('THE CHAIN WINS IN A START: A NEWER SECRET THE VAULT NEVER TOOK IS PASSED OVER, AND THE ONE IT HOLDS IS FILED AGAIN AS THE NEWEST', async () => {
    const log: string[] = [];
    const doors = await filedAlready();
    const theVaults = await anUnsetNewerSecret(doors.records, doors.me.companyKey);
    const b = { ...builder(log), secretIsTheVaults: async (i: { secret: string }) => i.secret === theVaults };
    await expect(createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: b }, VAULT))
      .resolves.toEqual({ vault: VAULT, state: 'started' });
    /* RED WHEN: a start ends with the records' newest secret one the vault does not hold, so every deposit and payment after it refuses. */
    const newest = (await doors.records('nonce-secret').get(VAULT))!;
    expect([newest.version, newestSecretIn(newest, doors.me.companyKey)]).toEqual([3, theVaults]);
  });

  it('A START OVER A VAULT WHOSE SECRET IS SET FILES THE ONE THIS WALLET KEPT, WHEN THE CHAIN SHOWS IT, AND MAKES NONE AFRESH', async () => {
    const log: string[] = [];
    const setOnChain = view({ heldByCommittee: true, nonceCommitment: '5c'.repeat(32) });
    const keptMap = new Map<string, unknown>();
    const kept = { keep: async (v: string, p: unknown) => { keptMap.set(v, p); }, held: async (v: string) => (keptMap.get(v) ?? null) as never, drop: async (v: string) => { keptMap.delete(v); } };
    const made = startNonceSecret(VAULT, [recordsReaderOf(new Uint8Array(32).fill(4))]);
    await kept.keep(VAULT, made);
    const theVaults = newestSecretIn(made, new Uint8Array(32).fill(4));
    /* The filing was withheld: the records hold nothing; the chain shows the kept secret. */
    const doors = startDoors();
    const b = { ...builder(log), secretIsTheVaults: async (i: { secret: string }) => i.secret === theVaults };
    /* RED WHEN: the start does not ask the chain about the kept secret, so a vault whose secret is set is stranded before its copies. */
    await expect(createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service: serviceFrom([setOnChain], log), builder: b, secretKeptHere: kept as never }, VAULT))
      .resolves.toEqual({ vault: VAULT, state: 'started' });
    expect(newestSecretIn((await doors.records('nonce-secret').get(VAULT))!, doors.me.companyKey)).toBe(theVaults);
    /* RED WHEN: a second device, which kept nothing, makes a fresh secret over it. */
    const second = startDoors();
    const e = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...second, account: ACCOUNT, service: serviceFrom([setOnChain], log), builder: b }, VAULT).catch((x) => x);
    expect(e).toBeInstanceOf(VaultStartOwed);
    expect((e as Error).message).toMatch(/already holds a secret[^]*on the device whose wallet made it/);
    expect(await second.records('nonce-secret').get(VAULT)).toBeNull();
  });

  /* RED WHEN: a start goes on with a signer the vault's filed secret is not wrapped to - their sealed copy would be missing. */
  it('a start stops, naming the vault, when a signer cannot open the filed secret', async () => {
    const log: string[] = [];
    const service = serviceFrom([held], log);
    const doors = startDoors();
    /* The seats the directory believes now name a reader the filed secret is not wrapped to. */
    const secretReaders = { ...doors.secretReaders, directory: async () => ({ ...await adasDirectory(), readers: ['5c'.repeat(32)] }) };
    await doors.records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReaderOf(doors.me.companyKey)]));
    const e = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, secretReaders, account: ACCOUNT, service, builder: builder(log) }, VAULT)
      .catch((x) => x);
    expect(e.name).toBe('VaultStartOwed');
    expect(e.vault).toBe(VAULT);
    expect(e.message).toMatch(/1 signer\(s\) cannot open the vault's filed secret/);
    expect(e.stoppedAt).toBe(START_STOP.readersCannotOpen);
  });

  /*
   * The sealed copies a vault keeps are sealed to the records keys the service lists. Before this device raises or
   * approves the run that sets the first secret, its own key must be on that list and its own copy must open.
   */
  describe('THIS SIGNER\'S OWN COPY IS CHECKED BEFORE THE FIRST SECRET RUN IS RAISED OR APPROVED', () => {
    const unset = (copies: Array<{ reader: string; parts: string[]; path: never[] }>) => (log: string[]): VaultBuilderClient => ({
      ...builder(log),
      governedCall: async () => { log.push('built a governed call'); throw new Error('stand-in: nothing is proved here'); },
      startStanding: async (i) => ({
        standing: {
          adopted: true, removals: 0,
          adoption: { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32), open: false, approvals: 0, needed: 1, stale: false, approvedHere: false },
          ...(i.secret === undefined ? {} : {
            secret: {
              set: false, another: false, held: '00'.repeat(32), landed: [], rootIsThisRuns: true, written: [false], started: false,
              /* Another signer raised the run from this secret, so this device approves it rather than replacing the secret. */
              run: {
                proposal: 'b1'.repeat(32), payload: 'b2'.repeat(32), named: 'b3'.repeat(32), salt: 'b4'.repeat(32),
                open: true, approvals: 1, needed: 2, stale: false, approvedHere: false, opensAt: '1', closesAt: '2', inWindow: true, beforeARemoval: false,
              },
            },
          }),
        },
        ...(i.secret === undefined ? {} : { run: { root: 'b5'.repeat(32), payees: '1', asset: 'b6'.repeat(32), copies } as never }),
      }),
    });
    const press = async (
      readers: (mine: string) => string[], copiesOf: (mine: string, secret: string) => Array<{ reader: string; parts: string[]; path: never[] }>,
      over: { secretReaders?: SecretReaderSources; view?: TestView } = {},
    ) => {
      const log: string[] = [];
      const doors = startDoors();
      const mine = recordsKeypairFrom(doors.me.companyKey);
      await doors.records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [recordsReaderOf(doors.me.companyKey), { publicKey: another }]));
      const secret = openNonceSecrets((await doors.records('nonce-secret').get(VAULT))!, VAULT, mine).secrets[0]!;
      const service = serviceFrom([over.view ?? held], log);
      /* Who the secret is sealed to: the seats the directory believes now, as the reader check reads them. */
      const believed = { ...doors.secretReaders, directory: async () => ({ ...await adasDirectory(), readers: readers(mine.publicKey) }) };
      const e = await createCompanyVault({
        ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service, builder: unset(copiesOf(mine.publicKey, secret))(log),
        secretReaders: over.secretReaders ?? believed,
      }, VAULT).catch((x) => x);
      return { e, log };
    };
    /* Another signer the company's record of the secret is wrapped to. */
    const another = recordsKeypairFrom(new Uint8Array(32).fill(9)).publicKey;
    const sealed = (vault: string, secret: string, reader: string) =>
      sealSecretCopy({ vault, secret, reader }).map((p) => toHex(p));

    /* RED WHEN the press stops checking that the directory's list of believed seats holds this device's own records key. */
    it('a list of believed seats without this signer\'s own records key is refused by name, and nothing is raised', async () => {
      const { e, log } = await press(() => [another], (mine, secret) => [{ reader: mine, parts: sealed(VAULT, secret, mine), path: [] }]);
      expect(e.name).toBe('VaultStartOwed');
      expect(e.vault).toBe(VAULT);
      expect(e.message).toMatch(/does not have the key your own recovery words give/);
      expect(log).not.toContain('built a governed call');
    });

    /* RED WHEN the press stops checking that this signer's copy in the run opens with this signer's own records key. */
    it('a run whose copy for this signer does not open with this signer\'s own key is refused by name, and nothing is raised', async () => {
      const otherVault = 'cd'.repeat(32);
      const { e, log } = await press((mine) => [mine], (mine, secret) => [{ reader: mine, parts: sealed(otherVault, secret, mine), path: [] }]);
      expect(e.name).toBe('VaultStartOwed');
      expect(e.message).toMatch(/would keep for you does not open with the key your own recovery words give/);
      expect(log).not.toContain('built a governed call');
      const none = await press((mine) => [mine], () => [{ reader: '5c'.repeat(32), parts: [], path: [] }]);
      expect(none.e.message).toMatch(/would keep for you does not open/);
      expect(none.log).not.toContain('built a governed call');
    });

    it('a run whose copy for this signer opens with this signer\'s own key, and whose every reader checks out, goes on to approve the run', async () => {
      /* A company of one: this signer's wallet signed their records key, and the chain lists their committee key. */
      const identity = identityFromSecret(new Uint8Array(32).fill(1));
      const companyKey = startDoors().me.companyKey;
      const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
      const statement = signRecordsKey(identity, LABEL, ACCOUNT, companyKey, ADAS.seat);
      const secretReaders = {
        company: LABEL, committeeKey, read: async () => walletRead(committeeKey),
        roster: async () => [{
          signerId: 'ada', userId: 'ada', name: 'Ada', filingKey: '00'.repeat(32) as never,
          keys: {
            committeeKey, recordsKey: statement.recordsKey as never,
            recordsKeyStatement: statement.signature as never, recordsKeySeat: statement.seat as never,
          },
        }],
        directory: adasDirectory,
      };
      const heldByThem = view({ heldByCommittee: true, authority: { committee: [committeeKey], threshold: 1, counter: '1', shape: 'committee' } });
      const { e, log } = await press((mine) => [mine], (mine, secret) => [{ reader: mine, parts: sealed(VAULT, secret, mine), path: [] }], { secretReaders, view: heldByThem });
      expect(log).toContain('built a governed call');
      expect(e.name).toBe('VaultStartOwed');
      expect(e.message).toMatch(/approving its first secret could not be built/);
    });

    /*
     * The company's record of the nonce secret is wrapped to the keys the service lists. Before it is first filed,
     * those keys are checked as the run's are: a key slipped onto the list would otherwise open the secret.
     */
    describe('BEFORE A NONCE SECRET IS FIRST FILED, THE KEYS IT WOULD BE WRAPPED TO ARE CHECKED', () => {
      const companyOfOne = () => {
        const identity = identityFromSecret(new Uint8Array(32).fill(1));
        const companyKey = startDoors().me.companyKey;
        const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
        const statement = signRecordsKey(identity, LABEL, ACCOUNT, companyKey, ADAS.seat);
        const secretReaders = {
          company: LABEL, committeeKey, read: async () => walletRead(committeeKey),
          roster: async () => [{
            signerId: 'ada', userId: 'ada', name: 'Ada', filingKey: '00'.repeat(32) as never,
            keys: {
              committeeKey, recordsKey: statement.recordsKey as never,
              recordsKeyStatement: statement.signature as never, recordsKeySeat: statement.seat as never,
            },
          }],
          directory: adasDirectory,
        };
        const heldByThem = view({ heldByCommittee: true, authority: { committee: [committeeKey], threshold: 1, counter: '1', shape: 'committee' } });
        return { secretReaders, heldByThem };
      };
      const pressUnfiled = async (readers: (mine: string) => string[]) => {
        const log: string[] = [];
        const doors = startDoors();
        const mine = recordsKeypairFrom(doors.me.companyKey).publicKey;
        const { secretReaders, heldByThem } = companyOfOne();
        const service = serviceFrom([heldByThem], log, { keys: async () => ({ committee, why: null, readers: readers(mine) }) });
        const e = await createCompanyVault({
          ...pacing, ...walletReadsTheVault, ...doors, secretReaders, account: ACCOUNT, service, builder: unset([])(log),
        }, VAULT).catch((x) => x);
        return { e, log, filed: await doors.records('nonce-secret').get(VAULT) };
      };

      /* RED WHEN the nonce secret is filed before the keys the service lists are checked. */
      it('a key the service slipped onto its list is refused, and no nonce secret is filed for it to open', async () => {
        const { e, log, filed } = await pressUnfiled((mine) => [mine, another]);
        expect(e.name).toBe('VaultStartOwed');
        expect(e.vault).toBe(VAULT);
        expect(e.stoppedAt).toBe('reader-not-a-signer');
        expect(filed).toBeNull();
        expect(log).not.toContain('built a governed call');
      });

      /* RED WHEN the check before filing refuses an honest list: the secret is then never filed and the start stops there. */
      it('an honest list is filed to, and the start goes on to its own copy', async () => {
        const { e, filed } = await pressUnfiled((mine) => [mine]);
        expect(filed).not.toBeNull();
        expect(e.name).toBe('VaultStartOwed');
        expect(e.message).toMatch(/would keep for you does not open/);
      });
    });
  });

});

describe('THE POOL AND A DEPOSIT', () => {
  const wrapping = recordsKeypairFrom(new Uint8Array(32).fill(3));
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(3) };
  const stores = () => {
    const s = new Map<WireRecord, MemorySealedPoolStore>();
    return (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
  };
  const poolDoors = (service: VaultService, records = stores()) => ({
    ...pacing, ...walletReadsTheVault, service, indexer: indexerOf(service), builder: { vaultOnChain: readOnTheDevice }, me, myRecordsKey: 'ff'.repeat(32), records,
    signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
  });

  /* RED WHEN: a nonce secret can be filed with no check of who it is wrapped to - the check made optional again. */
  it('A NONCE SECRET IS NEVER FILED WITHOUT THE CHECK OF WHO IT IS WRAPPED TO', async () => {
    const records = stores();
    const ready = view({ heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [] });
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([ready], []), records), VAULT, undefined as never)).rejects.toThrow();
    expect(await records('nonce-secret').get(VAULT)).toBeNull();
    /* RED WHEN: the pool is filed before the check, so the service's refusal of it speaks before the check's own words. */
    const refused = async () => { throw new Error('the readers were refused'); };
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([ready], []), records), VAULT, refused)).rejects.toThrow(/the readers were refused/);
    expect(await records('pool').get(VAULT)).toBeNull();
    expect(await records('nonce-secret').get(VAULT)).toBeNull();
    const seen: string[][] = [];
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], [], { keys: async () => ({ committee, why: null, readers: ['5c'.repeat(32)] }) }), records), VAULT,
      async (readers) => { seen.push([...readers]); });
    expect(seen).toEqual([['5c'.repeat(32)]]);
  });

  it('A NEW VAULT\'S SECRET KEPT ON THIS DEVICE IS FILED AGAIN WHEN THE RECORDS HOLD NONE, AND IS KNOWN AS MADE HERE WHEN READ BACK', async () => {
    const ready = view({ heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [] });
    const keptMap = new Map<string, unknown>();
    const kept = { keep: async (v: string, p: unknown) => { keptMap.set(v, p); }, held: async (v: string) => (keptMap.get(v) ?? null) as never, drop: async (v: string) => { keptMap.delete(v); } };
    const first = stores();
    const made = await openCompanyVaultPool({ ...poolDoors(serviceFrom([ready], []), first), secretKeptHere: kept as never }, VAULT, nothingToCheck);
    expect(made.madeHere).toBe(true);
    const filed = await first('nonce-secret').get(VAULT);
    await kept.keep(VAULT, filed);
    /* RED WHEN: a secret this device kept, which the service did not file, is replaced by a new one, so a vault whose commitment names it can never be finished. */
    const lost = stores();
    let readersAsked = 0;
    const again = await openCompanyVaultPool({ ...poolDoors(serviceFrom([ready], [], { keys: async () => { readersAsked += 1; return { committee, why: null, readers: [] }; } }), lost), secretKeptHere: kept as never }, VAULT, nothingToCheck);
    expect([again.secret, again.madeHere]).toEqual([made.secret, true]);
    expect(await lost('nonce-secret').get(VAULT)).toEqual(filed);
    expect(readersAsked).toBe(0);
    /* RED WHEN: a secret read back from the records that this device kept is taken as one it only read back, so its first secret run cannot be raised from here. */
    const back = await openCompanyVaultPool({ ...poolDoors(serviceFrom([ready], []), lost), secretKeptHere: kept as never }, VAULT, nothingToCheck);
    expect([back.secret, back.madeHere]).toEqual([made.secret, true]);
    const elsewhere = await openCompanyVaultPool(poolDoors(serviceFrom([ready], []), lost), VAULT, nothingToCheck);
    expect(elsewhere.madeHere).toBe(false);
  });

  it('A SECRET THE CHAIN ALREADY HOLDS IS NEVER MADE AFRESH, AND THE ONE THIS WALLET KEPT IS FILED AGAIN AS THE NEWEST WHEN THE CHAIN SHOWS IT', async () => {
    /* Device A made the secret and kept it; its page withheld the filing; the secret was set on the chain. */
    const ready = view({ heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [] });
    const set = view({ heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [], nonceCommitment: '5c'.repeat(32) });
    const keptMap = new Map<string, unknown>();
    const kept = { keep: async (v: string, p: unknown) => { keptMap.set(v, p); }, held: async (v: string) => (keptMap.get(v) ?? null) as never, drop: async (v: string) => { keptMap.delete(v); } };
    const onA = stores();
    const made = await openCompanyVaultPool({ ...poolDoors(serviceFrom([ready], []), onA), secretKeptHere: kept as never }, VAULT, nothingToCheck);
    await kept.keep(VAULT, await onA('nonce-secret').get(VAULT));
    const theChains = async (secret: string) => secret.toLowerCase() === made.secret.toLowerCase();
    /* Device B, same seat, an honest service that holds nothing, no secret kept on B. */
    const service = stores();
    const onB = openCompanyVaultPool(poolDoors(serviceFrom([set], []), service), VAULT, nothingToCheck, theChains);
    /* RED WHEN: a device makes a fresh secret over a vault whose secret the chain already holds, so the service's records name one the chain never will. */
    await expect(onB).rejects.toThrow(/already holds a secret[^]*on the device whose wallet made it/);
    expect(await service('nonce-secret').get(VAULT)).toBeNull();
    /* Another secret reached the records meanwhile (filed before the chain held one). */
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], []), service), VAULT, nothingToCheck);
    const before = await openCompanyVaultPool(poolDoors(serviceFrom([ready], []), service), VAULT, nothingToCheck);
    expect(before.secret).not.toBe(made.secret);
    /* Back on device A with an honest page. */
    const back = await openCompanyVaultPool({ ...poolDoors(serviceFrom([set], []), service), secretKeptHere: kept as never }, VAULT, nothingToCheck, theChains);
    /* RED WHEN: the secret this wallet kept, which the chain shows, is passed over for the records' other one, so the vault's copies are never written. */
    expect([back.secret, back.madeHere]).toEqual([made.secret, true]);
    /* RED WHEN: the kept secret is used but not filed again as the newest, so every other device still reads the one the chain does not hold. */
    expect((await openCompanyVaultPool(poolDoors(serviceFrom([set], []), service), VAULT, nothingToCheck, theChains)).secret).toBe(made.secret);
    /* RED WHEN: a kept secret the chain does not show is filed over a vault whose secret is set. */
    const none = stores();
    await expect(openCompanyVaultPool({ ...poolDoors(serviceFrom([set], []), none), secretKeptHere: kept as never }, VAULT, nothingToCheck, async () => false))
      .rejects.toThrow(/already holds a secret/);
    expect(await none('nonce-secret').get(VAULT)).toBeNull();
  });

  it('A POOL IS OPENED FOR A VAULT PINNED TO THE ACCOUNT WHATEVER KEYS HOLD IT, AND NO EMPTY ONE FOR A VAULT WITH MONEY', async () => {
    /* RED WHEN: opening a vault's pool reads who holds the vault - a committee change left half done would then stop it. */
    await openCompanyVaultPool(poolDoors(serviceFrom([oneKey], [])), VAULT, nothingToCheck);
    const records = stores();
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([view({ heldByCommittee: true, everCreated: ['01'] })], []), records), VAULT, nothingToCheck))
      .rejects.toThrow(/already put money in this vault and it has no pool/);
    expect(await records('pool').get(VAULT)).toBeNull();
  });

  it('A PRIVATE DEPOSIT INTO A VAULT WHOSE COMMITTEE DIFFERS FROM THE ACCOUNT\'S GOES AHEAD WHILE THE VAULT IS PINNED TO THE ACCOUNT', async () => {
    const log: string[] = [];
    const records = stores();
    /* Started and pinned to the company's account, and held by other keys than the account is, as the chain shows both. */
    const otherKeys = view({ heldByCommittee: false, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([otherKeys], log), records), VAULT, nothingToCheck);
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([otherKeys], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x) => x);
    /* RED WHEN: a deposit reads who holds the vault - a committee change the service leaves half done would then stop every deposit. */
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    /* The block is read for the deposit's parameters, for the account's count of removals, and for the count again before it is sent. */
    expect(log).toEqual(['read the block here', 'read the block here', `build deposit with ${PARAMS}`, 'paid', 'read the block here', 'sent deposit']);
  });

  it('A DEPOSIT WHOSE COIN\'S COMMITMENTS CANNOT BE WORKED OUT AFTER ITS BUILD STOPS BEFORE THE WALLET IS ASKED, HOLDING NOTHING', async () => {
    /* RED WHEN: the coin's commitments are worked out after the send - a vault worker that stops then reads as a failure, not as a deposit that may have been sent. */
    const log: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
    const base = builder(log);
    let built = false;
    const stopsAfterTheBuild: VaultBuilderClient = {
      ...base,
      deposit: async (input) => { const done = await base.deposit(input); built = true; return done; },
      commitments: async (input) => {
        if (built) throw new VaultAskFailed('commitments', 'stopped', 'the part of this page that builds and proves vault transactions stopped before it answered.');
        return base.commitments(input);
      },
    };
    const inFlight = inFlightInMemory<never>();
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([ready], log), records), company: LABEL, account: ACCOUNT, inFlight, builder: stopsAfterTheBuild,
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x) => x);
    expect(e).toBeInstanceOf(VaultAskFailed);
    expect(log).not.toContain('paid');
    expect(log).not.toContain('sent deposit');
    expect(await inFlight.get(VAULT)).toBeNull();
  });

  it('A DEPOSIT INTO A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER\'S OWN WALLET READS IT, IS REFUSED BEFORE A COIN IS CHOSEN', async () => {
    const log: string[] = [];
    const records = stores();
    const fundableView = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([fundableView], log), records), VAULT, nothingToCheck);
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([fundableView], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      onChain: async (v: string) => ({ ...(await walletReadsTheVault.onChain(v)), holders: { ...(await walletReadsTheVault.onChain(v)).holders, adoptedVaults: [] } }),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x: Error) => x);
    /* RED WHEN: money goes into a vault the service's rows name and the account never adopted. */
    expect((e as Error).message).toMatch(/not one your company's account has adopted/);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
  });

  it('A VAULT TAKES NO MONEY WHILE IT IS NOT STARTED, AND THE WALLET IS NEVER ASKED TO PAY; WHO HOLDS THE ACCOUNT IS NOT ASKED', async () => {
    /* RED WHEN: the fundable answer's check in `depositIntoCompanyVault` is removed or moved after the coin is chosen -
     * the log then carries 'build deposit' and 'paid', and the journal holds a coin for a deposit that cannot land. */
    const log: string[] = [];
    const records = stores();
    const notStarted = view({ heldByCommittee: true, started: false, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([notStarted], log), records), VAULT, nothingToCheck);
    await expect(depositIntoCompanyVault({
      ...poolDoors(serviceFrom([notStarted], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n })).rejects.toThrow(/this vault has not been started/);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
    /*
     * The company's account held by other keys, or at another threshold, than the vault, as the signer's own wallet
     * reads it. RED WHEN: who holds the vault is compared with who holds the account - a committee change the service
     * leaves half done would then stop every deposit.
     */
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    const temporary = async (v: string) => ({ ...(await walletReadsTheVault.onChain(v)), holders: { ...(await walletReadsTheVault.onChain(v)).holders, committee: [{ tag: 'schnorr', value: walletKey(0x77) }] } });
    const two = async (v: string) => ({ ...(await walletReadsTheVault.onChain(v)), holders: { ...(await walletReadsTheVault.onChain(v)).holders, threshold: 2 } });
    for (const onChain of [temporary, two]) {
      const goes: string[] = [];
      const own = stores();
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], goes), own), VAULT, nothingToCheck);
      const e = await depositIntoCompanyVault({
        ...poolDoors(serviceFrom([ready], goes), own), onChain, company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(goes),
        pay: async () => { goes.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x) => x);
      expect(e).toBeInstanceOf(DepositNotYetSeen);
      expect(goes).toContain('paid');
    }
  });

  it('A DEPOSIT IS BUILT ON THE PARAMETERS THIS DEVICE READ AT THE WALLET\'S INDEXER; WHAT THE SERVICE WOULD SERVE IS NEVER ASKED', async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
    const doors = poolDoors(serviceFrom([ready], log), records);
    await depositIntoCompanyVault({
      ...doors, service: aServiceThatLies(doors.service, asked), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch(() => undefined);
    /* RED WHEN: the deposit's block, or the transaction it is looked for in, is asked of the service. */
    expect(asked).toEqual([]);
    /* RED WHEN: the deposit is built with any parameters but those this device read. */
    expect(log.filter((l) => l.startsWith('build'))).toEqual([`build deposit with ${PARAMS}`]);
  });

  it('A DEPOSIT THE CHAIN HAS NOT SHOWN IS NOT RECORDED IN THE POOL, AND SAYS IT MAY STILL LAND', async () => {
    const log: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([ready], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x) => x);
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    /* RED WHEN: the deposit is built with anything but the parameters the block read served, or the block is not read. */
    /* The block is read for the deposit's parameters, for the account's count of removals, and for the count again before it is sent. */
    expect(log).toEqual(['read the block here', 'read the block here', `build deposit with ${PARAMS}`, 'paid', 'read the block here', 'sent deposit']);
    expect((await records('pool').versions(VAULT)).length).toBe(1);
    expect(await records('deposit-journal').get(VAULT)).not.toBeNull();
  });

  it('A DEPOSIT IS NOT SENT WHEN A REMOVAL IS COUNTED WHILE IT IS BUILT AND PAID FOR', async () => {
    const log: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
    const counts = [0, 1];
    const counting = { ...builder(log), startStanding: async () => ({ standing: { adopted: true, removals: counts.shift() ?? 1 } }) as never };
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([ready], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: counting,
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x) => x);
    /* RED WHEN: a deposit whose count moved after the gate is sent under the secret the signer who left holds. */
    expect(e).toBeInstanceOf(VaultSecretBeingChanged);
    expect(log.includes('sent deposit')).toBe(false);
  });

  it('A COIN THE LEDGER HAS ALREADY RECORDED IS REFUSED ON THE DEVICE, WITH THE FAST CHECK, BEFORE ANYTHING IS BUILT', async () => {
    /*
     * The vault's history holds the LEDGER'S OWN commitment (`vaultNoteCommitment`, the ledger's general code) of the
     * coin at each slot this deposit may use, and the device asks the worker's own `commitments`, which answers with the
     * vault's compiled commitment. So the refusal below is the fast check recognising what the ledger recorded.
     */
    const real = (log: string[]): VaultBuilderClient => ({
      ...builder(log),
      commitments: async (i) => {
        const a = await answerVaultAsk(async () => ({ vault: vaultModule }) as never, { id: 1, network: 'undeployed', ask: 'commitments', ...i });
        if (!a.ok || a.ask !== 'commitments') throw new Error('the worker did not answer the commitments');
        return { output: a.output, held: a.held };
      },
    });
    const money = { token: 'ab'.repeat(32) as never, value: 7n };
    const coinAt = async (records: ReturnType<typeof stores>, slot: number) => {
      const opened = openNonceSecrets((await records('nonce-secret').get(VAULT))!, VAULT, recordsKeypairFrom(me.companyKey));
      const nonce = depositNonceAt(currentDepositNonceKey(opened), money, slot);
      return { nonce, token: money.token, value: money.value };
    };
    /* Three coins the chain made, at slots 1, 2 and 3, and the vault holds the coins at 4, 5 and 6 now: with three
     * outputs in the history, 6 is the last slot a deposit may use. */
    const records = stores();
    const empty = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([empty], []), records), VAULT, nothingToCheck);
    const madeAt = async (slots: number[]) => Promise.all(slots.map(async (n) => vaultNoteCommitment(await coinAt(records, n), VAULT as never)));
    const log: string[] = [];
    const heldAt = async (slots: number[]) => Promise.all(slots.map(async (n) => (await real([]).commitments({
      vault: VAULT, coin: { ...(await coinAt(records, n)), value: money.value.toString() },
    })).held));
    const taken = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: await heldAt([4, 5, 6]), everCreated: await madeAt([1, 2, 3]) });
    const e = await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([taken], log), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: real(log),
      pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
    }, VAULT, money).catch((x) => x);
    /* RED WHEN: the worker's `output` is not the ledger's commitment (the held one, say), or the history is not asked. */
    expect(e).toBeInstanceOf(DepositCoinAlreadyMade);
    expect(log, 'RED WHEN: a coin the ledger has recorded reaches the builder or the wallet').toEqual(['read the block here', 'read the block here']);

    /* Two of the three taken: the deposit moves to the free slot and builds with that coin. */
    const log2: string[] = [];
    const built: string[] = [];
    const two = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [...await madeAt([1, 3]), 'f1'.repeat(32)] });
    await depositIntoCompanyVault({
      ...poolDoors(serviceFrom([two], log2), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(),
      builder: { ...real(log2), deposit: async (i) => { built.push(i.coin.nonce); return { tx: 'P' }; } },
      pay: async () => ({ transaction: 'X', leaves: [] }),
    }, VAULT, money).catch(() => undefined);
    expect(built, 'RED WHEN: a slot whose coin the ledger recorded is used, or a free one is skipped').toEqual([(await coinAt(records, 2)).nonce]);
  });

  it('A DEPOSIT WHOSE CHAIN PARAMETERS CANNOT BE READ CHOOSES NO COIN, BUILDS NOTHING AND ASKS NO WALLET', async () => {
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    const COULD_NOT_READ = /^the chain's current parameters could not be read for this vault, so no coin was chosen and nothing was built or sent/;
    const ANSWERED_WRONGLY = /^the chain your wallet reads answered with something other than this vault's current parameters \(.+\), so no coin was chosen and nothing was built or sent/;
    const refusals: Array<[string, Partial<ChainBehind>]> = [
      ['the block cannot be read', { payoutState: async () => { throw new Error('the chain could not be read'); } }],
      ['the block names no parameters', { payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: '', accountState: 'A' }) }],
      ['the block\'s parameters are not parameters', { payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: btoa('not parameters at all, just bytes'), accountState: 'A' }) }],
      ['the block\'s parameters are not base64', { payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: '%%%%', accountState: 'A' }) }],
    ];
    for (const [why, over] of refusals) {
      const log: string[] = [];
      const records = stores();
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
      /* RED WHEN: the parameters are read after the coin is chosen, or a failed or foreign read is let through -
       * the journal then holds a coin, and the log carries 'build deposit' or 'paid'. */
      const said = await depositIntoCompanyVault({
        ...poolDoors(serviceFrom([ready], log, over), records), company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).then(() => 'it went ahead', (x: Error) => x.message);
      /* RED WHEN: a block that cannot be read is called an answer the service got wrong, or the other way round. */
      expect(said, why).toMatch(why === 'the block cannot be read' ? COULD_NOT_READ : ANSWERED_WRONGLY);
      /* RED WHEN: any of a deposit's own refusals is worded for a payment. */
      expect(said, why).not.toMatch(/paid out|payment/i);
      expect(log.filter((l) => l !== 'read the block here'), why).toEqual([]);
      expect(await records('deposit-journal').get(VAULT), why).toBeNull();
    }
  });

  it('A DEPOSIT\'S REFUSAL CARRIES NONE OF THE PAYMENT ROUTE\'S WORDS WHEN THE BLOCK CANNOT BE READ', async () => {
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    /* What the route the block is read through answers when it refuses, word for word. */
    const routeSays = [
      'this company has no contract on the chain this service can read, so nothing can be paid out.',
      'this deployment reads no chain, so nothing can be paid out.',
      'the chain could not be read for this payment: the indexer is down',
    ];
    for (const said of routeSays) {
      const log: string[] = [];
      const records = stores();
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
      const e = await depositIntoCompanyVault({
        ...poolDoors(serviceFrom([ready], log, { payoutState: async () => { throw new Error(said); } }), records),
        company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x: Error) => x);
      expect((e as Error).message, said).toMatch(/current parameters could not be read.*no coin was chosen/);
      /* RED WHEN: the route's own refusal is carried into the deposit's, so a deposit says nothing can be paid out. */
      expect((e as Error).message, said).not.toMatch(/paid out|payment/i);
      expect(log.filter((l) => l !== 'read the block here'), said).toEqual([]);
      expect(await records('deposit-journal').get(VAULT), said).toBeNull();
    }
  });

  it('PARAMETERS OF A VERSION THIS PAGE DOES NOT BUILD WITH ARE REFUSED BEFORE A COIN\'S JOURNAL LINE IS FILED', async () => {
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    for (const other of ['v7', 'v9', 'v80', 'v']) {
      const log: string[] = [];
      const records = stores();
      const served = btoa(`midnight:ledger-parameters[${other}]:stand-in`);
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
      const e = await depositIntoCompanyVault({
        ...poolDoors(serviceFrom([ready], log, {
          payoutState: async (v) => ({ vault: v, account: ACCOUNT, blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: served, accountState: 'A' }),
        }), records),
        company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(), builder: builder(log),
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x: Error) => x);
      /* RED WHEN: only the header's start is checked, so another version reaches the worker after the journal line is filed. */
      expect((e as Error).message, other).toMatch(/different ledger version from the one this page builds deposits with, so no coin was chosen, nothing was built or sent/);
      expect((e as Error).message, other).not.toMatch(/paid out|payment/i);
      expect(log.filter((l) => l !== 'read the block here'), other).toEqual([]);
      expect(await records('deposit-journal').get(VAULT), other).toBeNull();
    }
  });
});

describe('A DEPOSIT THAT DOES NOT FINISH', () => {
  const wrapping = recordsKeypairFrom(new Uint8Array(32).fill(5));
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(5) };
  const MONEY = { token: 'ab'.repeat(32) as never, value: 7n };
  const HASH = 'e1'.repeat(32);
  type Coin = { nonce: string; token: string; value: string };
  /* Each commitment is over the whole coin, as the ledger's is: a coin read back with the wrong token or value matches nothing. */
  const outputOf = (c: Coin) => `out:${c.nonce}:${c.token}:${c.value}`;
  const heldOf = (c: Coin) => `held:${c.nonce}:${c.token}:${c.value}`;
  const coinsBuilt = (built: readonly Coin[], transaction: string) => {
    const coin = built[Number(/^P(\d+)/u.exec(transaction)?.[1] ?? 0) - 1];
    return coin === undefined ? [] : [{ contract: VAULT, commitment: outputOf(coin) }];
  };
  /** A chain this test moves by hand: what the vault holds, what it ever made, and each transaction's events. */
  const world = () => {
    const w = {
      notes: [] as string[], everCreated: [] as string[],
      events: new Map<string, Array<{ transactionHash: string; details: { tag: string; commitment?: string; contract?: string; mtIndex?: string } }>>(),
      sent: [] as string[], asked: [] as string[], built: [] as Coin[], eventReads: 0,
      depositAnswer: { txRef: 'p', transactionHash: HASH as string | null },
      sendFails: null as null | Error,
      lookups: 0, historyUnreadable: false,
    };
    const service = serviceFrom([], w.asked, {
      chain: async () => view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [...w.notes], everCreated: [...w.everCreated] }),
      deposit: async (_v, tx) => { if (w.sendFails) throw w.sendFails; w.sent.push(tx); return w.depositAnswer; },
      events: async (_v, tx) => {
        w.eventReads += 1;
        const e = w.events.get(tx);
        if (e === undefined) throw new Error('the indexer does not hold this transaction yet');
        return { events: e };
      },
      /* The vault's own history, newest first, searched by an output's commitment. */
      createdBy: async (_v, commitment) => {
        w.lookups += 1;
        if (w.historyUnreadable) throw new Error('the indexer could not list this vault\'s transactions');
        for (const [hash, events] of [...w.events].reverse()) {
          if (events.some((e) => e.details.tag === 'zswapOutput' && e.details.commitment === commitment && e.details.contract === VAULT)) {
            return { transactionHash: hash, events };
          }
        }
        return null;
      },
    });
    const b: VaultBuilderClient = {
      ...builder([]),
      deposit: async (i) => { w.built.push(i.coin); return { tx: `P${w.built.length}` }; },
      commitments: async (i) => ({ output: outputOf(i.coin), held: heldOf(i.coin) }),
      /* The deposit built `P<n>`, and what the wallet hands back for it, create the one coin built n-th. */
      readTransaction: async (i) => ({ ...(await builder([]).readTransaction!(i))!, coinsForContracts: coinsBuilt(w.built, i.transaction) }),
    };
    /** The chain takes the deposit of `coin` in transaction `hash`. */
    const lands = (coin: Coin, hash = HASH) => {
      w.notes.push(heldOf(coin));
      w.everCreated.push(outputOf(coin));
      w.events.set(hash, [{ transactionHash: hash, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '4' } }]);
    };
    return { w, service, b, lands };
  };
  const stores = () => {
    const kept = new Map<WireRecord, MemorySealedPoolStore>();
    return (r: WireRecord) => kept.get(r) ?? kept.set(r, new MemorySealedPoolStore()).get(r)!;
  };
  const setUp = async () => {
    const t = world();
    const records = stores();
    const kept = new Map<string, Kept<DepositInFlight>>();
    let now = 1_000_000;
    const doors = {
      ...pacing, ...walletReadsTheVault, service: t.service, indexer: indexerOf(t.service), me, myRecordsKey: 'ff'.repeat(32), records,
      signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
      company: LABEL, account: ACCOUNT, builder: t.b, inFlight: inFlightInMemory(kept), clock: () => now,
      pay: async (ask: { transaction: string }) => ({ transaction: `${ask.transaction}+coins`, leaves: [] }),
    };
    await openCompanyVaultPool(doors, VAULT, nothingToCheck);
    const pool = new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret },
      async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }]);
    return { ...t, doors, records, kept, pool, later: (ms: number) => { now += ms; } };
  };

  /* What the wallet hands back in place of the deposit built here: each one changes the read of it, or cannot be read. */
  const theCall = { address: VAULT, entryPoint: 'payout', segments: [1] };
  for (const [why, handedBack] of [
    ['without the coin built', () => ({ coinsForContracts: [] })],
    ['with the coin built twice', (own: { contract: string; commitment: string }) => ({ coinsForContracts: [own, own] })],
    ['with the coin made for another vault', (own: { contract: string; commitment: string }) => ({ coinsForContracts: [{ ...own, contract: 'ef'.repeat(32) }] })],
    ['with a coin of another amount', (own: { contract: string; commitment: string }) => ({ coinsForContracts: [{ ...own, commitment: own.commitment.replace(/:7$/u, ':8') }] })],
    ['with a coin of another token', (own: { contract: string; commitment: string }) => ({ coinsForContracts: [{ ...own, commitment: own.commitment.replace(MONEY.token, 'cd'.repeat(32)) }] })],
    ['with the coin built made and spent again inside it', (own: { contract: string; commitment: string }) => ({ coinsForContracts: [{ ...own, madeAndSpent: true }] })],
  ['with a coin for another contract beside it', (own: { contract: string; commitment: string }) => ({ coinsForContracts: [own, { contract: 'ef'.repeat(32), commitment: 'e3'.repeat(32) }] })],
    ['with a call more than was built', () => ({ calls: [theCall, { address: 'ef'.repeat(32), entryPoint: 'payout', segments: [2] }] })],
    ['without the call built', () => ({ calls: [] })],
    ['with public money taken in', () => ({ publicTakes: [{ address: VAULT, entryPoint: 'deposit', colour: 'cd'.repeat(32), amount: '1' }] })],
    ['with coins that cannot be read', () => ({ coinsForContracts: null })],
    ['with public takes that cannot be read', () => ({ publicTakes: null })],
    ['that cannot be read at all', () => null],
  ] as const) {
    it(`A DEPOSIT THE WALLET HANDS BACK ${why.toUpperCase()} IS NOT SENT, AND THIS BROWSER LETS IT GO`, async () => {
      const t = await setUp();
      const stages: string[] = [];
      const honest = t.doors.builder.readTransaction!;
      const e = await depositIntoCompanyVault({
        ...t.doors, progress: (s: string) => { stages.push(s); },
        builder: {
          ...t.doors.builder,
          readTransaction: async (i: { transaction: string }) => {
            const read = (await honest(i))!;
            if (!i.transaction.endsWith('+coins')) return read;
            const changed = handedBack({ contract: VAULT, commitment: outputOf(t.w.built[0]!) });
            return changed === null ? null : { ...read, ...changed };
          },
        },
      }, VAULT, MONEY).catch((x: unknown) => x);
      /* RED WHEN: a wallet that hands back another coin, another vault, a second copy or other calls has it sent all the same. */
      expect(e, why).toBeInstanceOf(DepositNotAsBuilt);
      /* RED WHEN: the screen reads it as a deposit that may have been sent. */
      expect(e, why).toBeInstanceOf(DepositNotSent);
      expect((e as Error).message, why).toMatch(/^the deposit was not sent, so no money moved \(your wallet handed back a deposit other than the one this device built: /);
      expect(t.w.sent, why).toEqual([]);
      expect(stages, why).not.toContain('sending the deposit');
      /* RED WHEN: a deposit that was never sent stays kept on its way here, and stops the next one. */
      expect(t.kept.size, why).toBe(0);
      expect((await t.pool.load(VAULT)).notes, why).toEqual([]);
      /* The next deposit, handed back as built, is sent. */
      const next = await depositIntoCompanyVault({ ...t.doors, pay: async (ask) => {
        t.lands(t.w.built[t.w.built.length - 1]!);
        return { transaction: `${ask.transaction}+coins`, leaves: [] };
      } }, VAULT, { ...MONEY, value: MONEY.value + 1n });
      expect(next.note.value, why).toBe(MONEY.value + 1n);
      expect(t.w.sent, why).toHaveLength(1);
    });
  }

  it('A DEPOSIT ON ITS WAY IS FOUND BY WHAT THIS DEVICE READ AT THE WALLET\'S INDEXER, BY ITS NAME OR BY ITS OUTPUT; THE SERVICE IS NEVER ASKED', async () => {
    for (const named of [HASH, null]) {
      const t = await setUp();
      t.w.depositAnswer = { txRef: 'p', transactionHash: named };
      const asked: string[] = [];
      const doors = { ...t.doors, service: aServiceThatLies(t.doors.service, asked) };
      await depositIntoCompanyVault(doors, VAULT, MONEY).catch(() => undefined);
      t.lands(t.w.built[0]!);
      const reads = [t.w.eventReads, t.w.lookups];
      expect(await settleDepositInFlight(doors, VAULT), String(named)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });
      /* RED WHEN: the transaction a deposit landed in is asked of the service, by its name or by its output. */
      expect(asked, String(named)).toEqual([]);
      /* RED WHEN: the deposit is recorded without the chain being read here - by name when the send named one, else by its output. */
      expect([t.w.eventReads - reads[0]! > 0, t.w.lookups - reads[1]! > 0], String(named)).toEqual(named === null ? [false, true] : [true, false]);
    }
  });

  it('A DEPOSIT THAT LANDS IS KEPT ON THIS DEVICE AS A COIN BEFORE ITS RECORD ON ITS WAY IS LET GO, SO A REBUILD HERE FINDS IT WHATEVER THE SERVICE WITHHOLDS', async () => {
    const t = await setUp();
    t.w.depositAnswer = { txRef: 'p', transactionHash: HASH };
    const kept = coinsKeptOnThisDevice(inFlightInMemoryRecords(), { signerId: 'ada', wrappingSecret: wrapping.secret });
    const doors = { ...t.doors, kept };
    await depositIntoCompanyVault(doors, VAULT, MONEY).catch(() => undefined);
    t.lands(t.w.built[0]!);
    const settled = await settleDepositInFlight(doors, VAULT);
    expect(settled).toMatchObject({ state: 'recorded' });
    /* RED WHEN: the coin of a deposit this device made is not kept here once it lands. */
    expect((await kept.coins(VAULT)).map((c) => c.nonce)).toEqual([(settled as { note: { nonce: string } }).note.nonce]);
    expect(t.kept.size).toBe(0);
  });

  it('A DEPOSIT THE WALLET FINISHED AND THE SERVICE REFUSED TO SEND SAYS NO MONEY MOVED, AND LEAVES NOTHING IN FLIGHT', async () => {
    const t = await setUp();
    t.w.sendFails = Object.assign(new Error('the fee payer would not take it'), { nothingWasSent: true });
    const e = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a refused send is reported as a deposit that may still land, or the page stops saying the wallet may hold coins. */
    expect(e).toBeInstanceOf(DepositNotSent);
    expect((e as Error).message).toMatch(/no money moved.*wallet may show part of its balance as held/);
    expect(t.kept.size, 'RED WHEN: a deposit that was never sent is kept in flight, so the next one is refused for nothing').toBe(0);
    const failing = await setUp();
    const walletSaidNo = await depositIntoCompanyVault({ ...failing.doors, pay: async () => { throw new Error('the person closed the wallet'); } }, VAULT, MONEY).catch((x) => x);
    expect((walletSaidNo as Error).message).toMatch(/closed the wallet/);
    expect(failing.kept.size, 'RED WHEN: a deposit the wallet never finished is kept in flight').toBe(0);
  });

  it('A SEND THAT MAY HAVE LANDED IS KEPT IN FLIGHT, BEFORE THE WALLET IS ASKED, AND SAYS THE MONEY MAY HAVE MOVED', async () => {
    const t = await setUp();
    let keptBeforeTheWallet = false;
    t.w.sendFails = new Error('the connection dropped');
    const e = await depositIntoCompanyVault({
      ...t.doors, pay: async (ask) => { keptBeforeTheWallet = t.kept.size === 1; return { transaction: `${ask.transaction}+coins`, leaves: [] }; },
    }, VAULT, MONEY).catch((x) => x);
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    expect((e as Error).message).toMatch(/^the deposit may have been sent/);
    expect(keptBeforeTheWallet, 'RED WHEN: the record of the deposit is written after the wallet is asked, so a closed page loses it').toBe(true);
    expect([...t.kept.values()].map((d) => d.coin), 'RED WHEN: a send that may have landed is forgotten').toEqual([t.w.built[0]]);
  });

  it('A DEPOSIT, ITS WAIT AND ITS SETTLING READ THE VAULT ON THIS DEVICE, AND THE SERVICE IS NEVER ASKED WHAT THE VAULT HOLDS', async () => {
    const t = await setUp();
    const asked = { n: 0 };
    const doors = theServiceNeverAsked(t.doors, asked);
    /* RED WHEN: the deposit, or its wait for the note, reads the vault through the service's chain route. */
    await expect(depositIntoCompanyVault(doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    t.lands(t.w.built[0]!);
    /* RED WHEN: settling on its own reads the vault through the service's chain route. */
    expect(await settleDepositInFlight(doors, VAULT)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });
    expect(asked.n).toBe(0);
  });

  it('A DEPOSIT INTO A VAULT PINNED TO ANOTHER ACCOUNT, OR WHOSE STATE NAMES NONE, IS REFUSED BEFORE A COIN IS CHOSEN', async () => {
    const t = await setUp();
    for (const account of ['dd'.repeat(32), null]) {
      const b = { ...t.b, vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => ({ ...(await t.b.vaultOnChain(i)), account }) as never };
      /* RED WHEN: the account the vault is pinned to is not compared with the company's - its money would be paid out on somebody else's approvals. */
      await expect(depositIntoCompanyVault({ ...t.doors, builder: b }, VAULT, MONEY)).rejects.toThrow(/not pinned to your company's account, or its state is not a vault's/);
    }
    expect([t.w.built.length, t.w.sent.length, t.kept.size]).toEqual([0, 0, 0]);
  });

  it('A READ OF THE VAULT THAT FAILS ONCE THE DEPOSIT IS SENT SAYS IT MAY HAVE LANDED, NEVER THAT NOTHING WAS SENT', async () => {
    const t = await setUp();
    let reads = 0;
    const b = {
      ...t.b,
      vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => {
        reads += 1;
        if (reads > 1) throw new Error('the indexer did not answer');
        return t.b.vaultOnChain(i);
      },
    };
    const e = await depositIntoCompanyVault({ ...t.doors, builder: b }, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a read that fails while waiting for a sent deposit escapes as VaultNotReadHere, which says nothing was sent. */
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    expect([t.w.sent.length, t.kept.size], 'the deposit was sent and is kept on its way').toEqual([1, 1]);
  });

  it('WHAT THE SERVICE SAYS THE VAULT HOLDS IS NOT BELIEVED: A NOTE ONLY ITS ANSWER SHOWS IS NOT RECORDED', async () => {
    const t = await setUp();
    await expect(depositIntoCompanyVault(t.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    const coin = t.w.built[0]!;
    const lying = {
      ...t.doors,
      service: { ...t.service, chain: async () => view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [heldOf(coin)], everCreated: [outputOf(coin)] }) },
    };
    /* RED WHEN: settling believes the service's notes - a deposit the chain does not hold is recorded as the vault's. */
    await expect(settleDepositInFlight(lying, VAULT)).rejects.toBeInstanceOf(DepositStillInFlight);
    expect((await t.pool.load(VAULT)).notes).toEqual([]);
  });

  it('A WALLET THAT NAMES NO INDEXER, OR A READ THAT FAILS ON THIS DEVICE: REFUSED BY NAME, NOTHING CHOSEN, KEPT OR SENT, AND THE SERVICE NOT ASKED IN ITS PLACE', async () => {
    const t = await setUp();
    const asked = { n: 0 };
    const e = await depositIntoCompanyVault({ ...theServiceNeverAsked(t.doors, asked), indexer: async () => null }, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a wallet that names no indexer falls back to the service's answer, or the refusal does not say what resolves it. */
    expect(e).toBeInstanceOf(VaultNotReadHere);
    expect((e as Error).message).toMatch(/^your wallet did not say which indexer .* Unlock your wallet for this company again, then try again\. The company's service is not asked in its place\. Nothing was sent\.$/);
    const unread = await depositIntoCompanyVault({
      ...theServiceNeverAsked(t.doors, asked), builder: { ...t.b, vaultOnChain: async () => { throw new Error('the indexer did not answer'); } },
    }, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a read that failed on this device is answered from the service instead. */
    expect(unread).toBeInstanceOf(VaultNotReadHere);
    expect((unread as Error).message).toMatch(/could not read the vault from the chain \(the indexer did not answer\)/);
    expect([t.w.built.length, t.w.sent.length, t.kept.size, asked.n]).toEqual([0, 0, 0, 0]);
  });

  it('A DEPOSIT NOT YET SEEN IS FOUND WHEN IT LANDS: THE NEXT DEPOSIT RECORDS IT FIRST, UNDER ITS OWN TRANSACTION, AND THE POOL MATCHES THE CHAIN', async () => {
    const t = await setUp();
    const first = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    expect(first).toBeInstanceOf(DepositNotYetSeen);
    expect((await t.pool.load(VAULT)).notes, 'the note is not recorded before the chain holds it').toEqual([]);
    const firstCoin = t.w.built[0]!;
    t.lands(firstCoin);
    /* The same money again: its lowest slot is now the first deposit's, which is taken. */
    const second = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    const notes = (await t.pool.load(VAULT)).notes;
    /* RED WHEN: nothing looks for the earlier deposit again - the pool then never holds the note the chain does. */
    expect(notes.find((n) => n.nonce === firstCoin.nonce), 'RED WHEN: the earlier deposit is not recorded once it lands')
      .toMatchObject({ nonce: firstCoin.nonce, value: 7n, createdIn: HASH });
    expect(second, 'the second deposit then goes ahead, and is itself not yet seen').toBeInstanceOf(DepositNotYetSeen);
    expect(t.w.built, 'RED WHEN: the second deposit is not built').toHaveLength(2);
    expect(t.w.built[1]!.nonce, 'RED WHEN: the second deposit of the same money is built from the coin the first one made').not.toBe(firstCoin.nonce);
    /* The pool holds exactly what the chain holds of these deposits. */
    expect(notes.map((n) => heldOf({ nonce: n.nonce, token: n.token, value: n.value.toString() })).sort()).toEqual([...t.w.notes].sort());
  });

  it('AN EARLIER DEPOSIT THAT HAS LANDED IS RECORDED EVEN WHEN THIS ONE IS REFUSED FOR THE CHAIN\'S LEDGER VERSION', async () => {
    const t = await setUp();
    const first = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    expect(first).toBeInstanceOf(DepositNotYetSeen);
    const firstCoin = t.w.built[0]!;
    t.lands(firstCoin);
    const otherVersion = btoa('midnight:ledger-parameters[v9]:stand-in');
    const builder = { ...t.doors.builder, chainAtOneBlock: async () => ({ blockHash: 'B1', vaultState: 'V', zswapState: 'Z', parameters: otherVersion, accountState: 'A' }) };
    const second = await depositIntoCompanyVault({ ...t.doors, builder }, VAULT, MONEY).catch((x) => x);
    expect((second as Error).message).toMatch(/different ledger version/);
    /* RED WHEN: the ledger version is checked before the earlier deposit is settled, so a landed note waits for a page update. */
    expect((await t.pool.load(VAULT)).notes.find((n) => n.nonce === firstCoin.nonce), 'the landed deposit was not recorded')
      .toMatchObject({ nonce: firstCoin.nonce, value: 7n, createdIn: HASH });
    expect(t.w.built, 'the refused deposit was built').toHaveLength(1);
  });

  it('WHILE AN EARLIER DEPOSIT CAN STILL LAND, NO SECOND ONE IS BUILT; ONCE IT CAN NO LONGER LAND, IT IS LET GO', async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    const before = (await t.records('deposit-journal').versions(VAULT)).length;
    const e = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a second deposit of the same money is built while the first is unresolved - the same coin, refused after its fee. */
    expect(e).toBeInstanceOf(DepositStillInFlight);
    expect(t.w.built, 'nothing is built for the second deposit').toHaveLength(1);
    expect((await t.records('deposit-journal').versions(VAULT)).length, 'no line is filed for it').toBe(before);
    t.later(DEPOSIT_TIME_TO_LIVE_MS + DEPOSIT_CLOCKS_MAY_DIFFER_MS - 1);
    await expect(settleDepositInFlight(t.doors, VAULT), 'RED WHEN: a deposit is let go before it can no longer land').rejects.toBeInstanceOf(DepositStillInFlight);
    t.later(2);
    expect(await settleDepositInFlight(t.doors, VAULT)).toEqual({ state: 'never-landed' });
    expect(t.kept.size).toBe(0);
    expect((await t.pool.load(VAULT)).notes, 'RED WHEN: a deposit that never landed is recorded').toEqual([]);
  });

  it('A FOLLOW-UP RECORDS ONLY WHAT THE VAULT HOLDS, AND ONLY UNDER A TRANSACTION WHOSE EVENTS SHOW IT', async () => {
    /* The chain made the coin and the vault's notes, read a moment apart, do not show it: nothing is recorded, and it is kept. */
    const apart = await setUp();
    await depositIntoCompanyVault(apart.doors, VAULT, MONEY).catch(() => undefined);
    apart.w.everCreated.push(outputOf(apart.w.built[0]!));
    apart.later(DEPOSIT_TIME_TO_LIVE_MS * 2);
    await expect(settleDepositInFlight(apart.doors, VAULT)).rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
    expect((await apart.pool.load(VAULT)).notes, 'RED WHEN: a note the vault\'s notes do not hold is recorded').toEqual([]);
    expect(apart.kept.size, 'RED WHEN: a deposit the chain made is forgotten before it is recorded, however long ago it was sent').toBe(1);
    apart.w.notes.push(heldOf(apart.w.built[0]!));
    apart.w.events.set(HASH, [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: outputOf(apart.w.built[0]!), contract: VAULT, mtIndex: '4' } }]);
    expect(await settleDepositInFlight(apart.doors, VAULT)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });

    /* The vault holds it and the transaction the service named shows some other coin: the note is recorded, with no transaction. */
    const other = await setUp();
    await depositIntoCompanyVault(other.doors, VAULT, MONEY).catch(() => undefined);
    other.w.notes.push(heldOf(other.w.built[0]!));
    other.w.events.set(HASH, [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: 'ff'.repeat(32), contract: VAULT, mtIndex: '1' } }]);
    const settled = await settleDepositInFlight(other.doors, VAULT);
    expect(settled.state).toBe('recorded');
    const [note] = (await other.pool.load(VAULT)).notes;
    expect(note?.createdIn, 'RED WHEN: a transaction whose events do not show the note is recorded as its creator').toBeUndefined();
    expect((settled as { notYetSpendable?: string }).notYetSpendable, 'RED WHEN: a note that cannot be paid out yet is recorded silently')
      .toMatch(/does not show this deposit/);

    /* The service could not name the transaction and the vault's history does not list one yet: nothing is recorded, and it is kept. */
    const nameless = await setUp();
    nameless.w.depositAnswer = { txRef: 'p', transactionHash: null };
    const waited = await depositIntoCompanyVault({ ...nameless.doors, pay: async (ask) => {
      nameless.w.notes.push(heldOf(nameless.w.built[0]!));
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY).catch((x) => x);
    expect(waited, 'RED WHEN: a note is recorded under a transaction nothing established').toBeInstanceOf(DepositLandedNotYetRecorded);
    expect((await nameless.pool.load(VAULT)).notes).toEqual([]);
    expect(nameless.kept.size).toBe(1);
  });

  it('A DEPOSIT WHOSE SEND GAVE NO HASH IS RECORDED UNDER ITS CREATING TRANSACTION ONCE IT LANDS, FOUND BY ITS OWN OUTPUT', async () => {
    const LANDED_IN = 'e7'.repeat(32);
    /* The service answered without a hash, and the vault's history lists the transaction by the time the note shows. */
    const nameless = await setUp();
    nameless.w.depositAnswer = { txRef: 'p', transactionHash: null };
    const done = await depositIntoCompanyVault({ ...nameless.doors, pay: async (ask) => {
      nameless.lands(nameless.w.built[0]!, LANDED_IN);
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY);
    /* RED WHEN: the page stops looking the transaction up by the deposit's output - the note is then recorded with none. */
    expect(done.note.createdIn, 'RED WHEN: a deposit with no hash from its send is recorded without its creating transaction').toBe(LANDED_IN);
    expect(done.notYetSpendable).toBeUndefined();
    expect(nameless.kept.size).toBe(0);

    /* The answer to the send was lost altogether and the page was closed; the next look from this browser records it. */
    const dropped = await setUp();
    dropped.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(dropped.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    dropped.lands(dropped.w.built[0]!, LANDED_IN);
    const settled = await settleDepositInFlight(dropped.doors, VAULT);
    expect(settled, 'RED WHEN: a deposit whose send outcome was unknown lands and is recorded with no creating transaction')
      .toMatchObject({ state: 'recorded', note: { createdIn: LANDED_IN } });
    expect((await dropped.pool.load(VAULT)).notes[0]?.createdIn).toBe(LANDED_IN);

    /* Another vault's output under the same commitment is not this deposit's: the vault worker refuses it, so it is not recorded under it. */
    const foreign = await setUp();
    foreign.w.sendFails = new Error('the connection dropped');
    await depositIntoCompanyVault(foreign.doors, VAULT, MONEY).catch(() => undefined);
    const coin = foreign.w.built[0]!;
    foreign.w.notes.push(heldOf(coin));
    foreign.w.everCreated.push(outputOf(coin));
    foreign.w.events.set(LANDED_IN, [
      { transactionHash: LANDED_IN, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '4' } },
      { transactionHash: LANDED_IN, details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: 'ee'.repeat(32), mtIndex: '5' } },
    ]);
    const refused = await settleDepositInFlight(foreign.doors, VAULT);
    expect((await foreign.pool.load(VAULT)).notes[0]?.createdIn,
      'RED WHEN: the page records a transaction the vault worker did not establish').toBeUndefined();
    expect((refused as { notYetSpendable?: string }).notYetSpendable).toMatch(/does not show this deposit/);
  });

  it('A DEPOSIT THE VAULT HOLDS WHOSE TRANSACTION CANNOT BE READ YET IS NOT RECORDED UNTIL IT CAN BE, OR UNTIL ITS TIME TO LIVE HAS PASSED', async () => {
    const t = await setUp();
    const e = await depositIntoCompanyVault({ ...t.doors, pay: async (ask) => {
      /* The note lands at once, and the indexer has not got the transaction's events. */
      t.w.notes.push(heldOf(t.w.built[0]!));
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: the note is recorded with the service's hash before the chain's events confirm it. */
    expect(e).toBeInstanceOf(DepositLandedNotYetRecorded);
    expect((await t.pool.load(VAULT)).notes).toEqual([]);
    expect(t.kept.size, 'RED WHEN: it is forgotten while its note is unrecorded').toBe(1);
    await expect(settleDepositInFlight(t.doors, VAULT)).rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
    /* Past its time to live, with the events still unreadable: recorded without a transaction, rather than blocking every later deposit. */
    t.later(DEPOSIT_TIME_TO_LIVE_MS + DEPOSIT_CLOCKS_MAY_DIFFER_MS + 1);
    const gaveUp = await settleDepositInFlight(t.doors, VAULT);
    expect(gaveUp, 'RED WHEN: a note the vault holds is kept waiting for ever on a transaction nobody can read')
      .toMatchObject({ state: 'recorded', notYetSpendable: expect.stringMatching(/could not read the transfer/) });
    expect((await t.pool.load(VAULT)).notes[0]?.createdIn).toBeUndefined();
    expect(t.kept.size).toBe(0);

    /* And when the events do come in time, the note is recorded under its own transaction. */
    const u = await setUp();
    await depositIntoCompanyVault({ ...u.doors, pay: async (ask) => {
      u.w.notes.push(heldOf(u.w.built[0]!));
      return { transaction: `${ask.transaction}+coins`, leaves: [] };
    } }, VAULT, MONEY).catch(() => undefined);
    u.w.events.set(HASH, [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: outputOf(u.w.built[0]!), contract: VAULT, mtIndex: '4' } }]);
    expect(await settleDepositInFlight(u.doors, VAULT)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });
    expect(u.kept.size).toBe(0);
  });

  it('EVENTS THE VAULT WORKER CANNOT JUDGE, OR CANNOT JUDGE YET, LEAVE THE DEPOSIT UNRECORDED UNTIL THEY CAN BE, OR UNTIL ITS TIME TO LIVE HAS PASSED', async () => {
    const judges: Array<VaultBuilderClient['creatingTransaction']> = [
      async () => { throw new Error('the part of this page that builds vault transactions stopped'); },
      async () => ({ state: 'unreadable' }),
    ];
    for (const judge of judges) {
      const t = await setUp();
      t.b.creatingTransaction = judge;
      await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
      t.lands(t.w.built[0]!);
      await expect(settleDepositInFlight(t.doors, VAULT),
        'RED WHEN: a deposit whose events were not judged is recorded, or reported as never showing it').rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
      expect((await t.pool.load(VAULT)).notes).toEqual([]);
      expect(t.kept.size).toBe(1);
      t.later(DEPOSIT_TIME_TO_LIVE_MS + DEPOSIT_CLOCKS_MAY_DIFFER_MS + 1);
      expect(await settleDepositInFlight(t.doors, VAULT), 'RED WHEN: an unjudged transaction is given the words of a refused one')
        .toMatchObject({ state: 'recorded', notYetSpendable: expect.stringMatching(/could not read the transfer/) });
    }
  });

  it('EVENTS SERVED UNDER ANOTHER TRANSACTION\'S HASH DO NOT NAME THE DEPOSIT\'S', async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    t.lands(t.w.built[0]!);
    t.w.events.set(HASH, t.w.events.get(HASH)!.map((e) => ({ ...e, transactionHash: 'e2'.repeat(32) })));
    const settled = await settleDepositInFlight(t.doors, VAULT);
    expect((await t.pool.load(VAULT)).notes[0]?.createdIn,
      'RED WHEN: the page names the transaction from the events it was served rather than the one the service named').toBeUndefined();
    expect((settled as { notYetSpendable?: string }).notYetSpendable).toMatch(/does not show this deposit/);
  });

  it('THE VAULT WORKER NAMES THE CREATING TRANSACTION, REFUSES ONE WHOSE EVENTS DO NOT SHOW THE NOTE, AND CALLS NO EVENTS UNREADABLE', async () => {
    const own = [{ transactionHash: HASH, details: { tag: 'zswapOutput', commitment: 'aa'.repeat(32), contract: VAULT, mtIndex: '4' } }];
    const ask = (commitment: string, events: typeof own) => answerVaultAsk(async () => ({}) as never, {
      id: 3, network: 'undeployed', ask: 'creating-transaction', vault: VAULT, commitment, transactionHash: HASH, events,
    });
    expect(await ask('aa'.repeat(32), own), 'RED WHEN: the worker does not name the transaction its events show')
      .toEqual({ id: 3, ok: true, ask: 'creating-transaction', answer: { state: 'found', createdIn: HASH } });
    expect((await ask('bb'.repeat(32), own) as { answer: unknown }).answer, 'RED WHEN: events that do not show the note are not a refusal')
      .toEqual({ state: 'refused' });
    const another = own.map((e) => ({ ...e, transactionHash: 'e2'.repeat(32) }));
    expect((await ask('aa'.repeat(32), another) as { answer: unknown }).answer,
      'RED WHEN: events from a transaction other than the one named are taken as its own').toEqual({ state: 'refused' });
    expect(creatingTransactionOfNote({ vault: VAULT, commitment: 'aa'.repeat(32), transactionHash: HASH, events: [] }),
      'RED WHEN: no events at all is judged a refusal, which would record the note as never shown').toEqual({ state: 'unreadable' });

    /* Through the page's own client, with every answer copied as a message between threads is. */
    const listeners: Array<(event: { data: unknown }) => void> = [];
    const client = vaultBuilderOver({
      postMessage: (m) => {
        void answerVaultAsk(async () => ({}) as never, m as never).then((a) => listeners.forEach((l) => l({ data: structuredClone(a) })));
      },
      addEventListener: (_type, l) => { listeners.push(l); },
    }, 'undeployed');
    expect(await client.creatingTransaction({ vault: VAULT, commitment: 'aa'.repeat(32), transactionHash: HASH, events: own }),
      'RED WHEN: the page\'s client does not carry the worker\'s answer back').toEqual({ state: 'found', createdIn: HASH });
    expect(await client.creatingTransaction({ vault: VAULT, commitment: 'bb'.repeat(32), transactionHash: HASH, events: own }))
      .toEqual({ state: 'refused' });
  });

  it('A NOTE ANOTHER SIGNER ALREADY RECORDED IS NOT RECORDED TWICE, AND IS SETTLED WITHOUT ASKING THE CHAIN', async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    const coin = t.w.built[0]!;
    t.lands(coin);
    const now = await t.pool.load(VAULT);
    await t.pool.save(VAULT, { notes: [...now.notes, { nonce: coin.nonce as never, token: MONEY.token, value: 7n, createdIn: HASH as never }] }, now.readAt);
    const reads = t.w.eventReads;
    expect(await settleDepositInFlight(t.doors, VAULT)).toEqual({ state: 'already-recorded' });
    expect(t.w.eventReads, 'RED WHEN: a deposit already in the record still waits on the chain\'s events').toBe(reads);
    expect((await t.pool.load(VAULT)).notes, 'RED WHEN: a note already in the record is added again').toHaveLength(1);
    expect(t.kept.size).toBe(0);
  });
});

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

describe('A PUBLIC PAYMENT OUT', () => {
  const NOW = new Date(1_800_000_000_000);
  const TOKEN = '00'.repeat(32);
  const order = (pay: Partial<PrivatePaymentOnTheWire> = {}) => {
    const payment: PrivatePaymentOnTheWire = {
      index: 0, kind: 'unshielded', payee: 'mn_addr_x', token: TOKEN, amount: '250', blinding: '0b'.repeat(32),
      nonce: '0c'.repeat(32), leaf: '0d'.repeat(32), path: [], paid: false, ...pay,
    };
    return {
      payment,
      order: {
        asset: TOKEN, form: 'unshielded', symbol: 'NIGHT', vault: VAULT, proposal: '0f'.repeat(32), salt: '5a'.repeat(32),
        root: '9a'.repeat(32), payees: '1', opensAt: '1799999000', closesAt: '1800009000', payments: [payment],
      } as PrivatePaymentOrderOnTheWire,
    };
  };
  const doorsFor = (log: string[], answers: Array<boolean | null>, over: Partial<VaultService> & Partial<ChainBehind> = {},
    seen: TestView = view({ heldByCommittee: true, started: true })) => {
    let i = 0;
    const service = serviceFrom([seen], log, over);
    return {
      ...pacing, ...walletReadsTheVault, now: () => NOW,
      service, indexer: indexerOf(service),
      builder: builder(log),
      paidYet: async () => { log.push('asked the account'); return answers[Math.min(i++, answers.length - 1)]!; },
    };
  };

  it('A PUBLIC PAYMENT OUT OF A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER\'S OWN WALLET READS IT, IS REFUSED BEFORE ANYTHING IS BUILT', async () => {
    const log: string[] = [];
    const d = {
      ...doorsFor(log, [false]),
      onChain: async (v: string) => ({ holders: { committee: [], threshold: 1, seats: [], approvals: 1, vaultThresholds: [], policyBar: null, seatBar: seatBarOf(1, null), adoptedVaults: [], founding: '4a'.repeat(32), foundingCommittee: [{ tag: 'schnorr', value: walletKey(0x11) }] } }),
    };
    /* RED WHEN: public money is paid out of a vault the service named and the account never adopted. */
    await expect(payPubliclyFromCompanyVault(d, order())).rejects.toThrow(/not one your company's account has adopted/);
    expect(log.filter((l) => l.startsWith('build') || l.startsWith('sent'))).toEqual([]);
  });

  it('A PUBLIC PAYMENT IS BUILT ON THE BLOCK THIS DEVICE READ AT THE WALLET\'S INDEXER; WHAT THE SERVICE WOULD SERVE IS NEVER ASKED', async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const d = doorsFor(log, [false, true]);
    await payPubliclyFromCompanyVault({ ...d, service: aServiceThatLies(d.service, asked) }, order());
    /* RED WHEN: the block a public payment is built on is asked of the service. */
    expect(asked).toEqual([]);
    expect(log.filter((l) => l.startsWith('build'))).toEqual(['build public payout of 250 to mn_addr_x at B1']);
  });

  it('A PUBLIC PAYMENT OUT OF A VAULT WHOSE COMMITTEE DIFFERS FROM THE ACCOUNT\'S GOES AHEAD WHILE THE VAULT IS PINNED TO THE ACCOUNT', async () => {
    const log: string[] = [];
    /* Started and pinned to the company's account, and held by other keys than the account is, as the chain shows both. */
    const done = await payPubliclyFromCompanyVault(doorsFor(log, [false, true], {}, view({ heldByCommittee: false, started: true })), order());
    /* RED WHEN: a public payment reads who holds the vault - a committee change the service leaves half done would then stop it. */
    expect(done).toEqual({ txRef: 'u' });
    expect(log).toContain('sent public payout');
  });

  it('BUILDS THE VAULT\'S PUBLIC PAYOUT, SENDS IT THROUGH THE PUBLIC DOOR, AND IS DONE WHEN THE ACCOUNT RECORDS IT', async () => {
    const log: string[] = [];
    const done = await payPubliclyFromCompanyVault(doorsFor(log, [false, true]), order());
    /* RED WHEN: a public payment chooses a note, reads a note's events, goes out through the private door, or
     * reports done before the company's account records it. */
    expect(log).toEqual([
      'read the block here', 'build public payout of 250 to mn_addr_x at B1', 'sent public payout',
      'asked the account', 'asked the account',
    ]);
    expect(done).toEqual({ txRef: 'u' });
  });

  it('A PRIVATE PAYMENT IS NEVER PAID PUBLICLY, AND A PUBLIC ONE NEVER PRIVATELY', async () => {
    const log: string[] = [];
    /* RED WHEN: the public operation takes a payment the leg names as private - it would send a private payee public money. */
    await expect(payPubliclyFromCompanyVault(doorsFor(log, [true]), order({ kind: 'shielded', payee: 'mn_shield-addr_x' })))
      .rejects.toThrow(/^this payment is not a public one, so it is not paid publicly\. Nothing was sent\.$/);
    expect(log).toEqual([]);
    /* RED WHEN: the private operation takes a payment the leg names as public - it would spend a note on a public payee's leaf. */
    const wrapping = newWrappingKeypair();
    await expect(payPrivatelyFromCompanyVault({
      ...pacing, ...walletReadsTheVault, now: () => NOW, me: { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32) },
      myRecordsKey: 'ff'.repeat(32), records: () => new MemorySealedPoolStore(), seatHere: async () => null,
      signers: async () => [], ...hereAndThere(serviceFrom([view({ heldByCommittee: true, started: true })], log)), builder: builder(log),
      inFlight: inFlightInMemory<PaymentInFlight>(),
    }, order())).rejects.toThrow(/^this payment is not a private one, so it is not paid privately\. Nothing was sent\.$/);
    expect(log).toEqual([]);
  });

  it('IS NOT SENT FOR SOMEBODY THE ACCOUNT ALREADY RECORDS PAID, OR OUTSIDE THE APPROVED WINDOW', async () => {
    const log: string[] = [];
    /* RED WHEN: a public payee the account already records paid is offered a second payment. */
    await expect(payPubliclyFromCompanyVault(doorsFor(log, [true]), order({ paid: true })))
      .rejects.toThrow(/already records this person paid/);
    const late = { ...doorsFor(log, [true]), now: () => new Date(1_900_000_000_000) };
    /* RED WHEN: the window the signers approved is not asked before a public payment is built. */
    await expect(payPubliclyFromCompanyVault(late, order())).rejects.toThrow(/only inside the window/);
    expect(log).toEqual([]);
  });

  it('A PUBLIC PAYMENT OUT OF A VAULT NOT STARTED IS REFUSED BEFORE ANYTHING IS BUILT', async () => {
    const log: string[] = [];
    const notStarted = { chain: async () => view({ heldByCommittee: true, started: false }) };
    /* RED WHEN: the public payment's check of the fundable answer is removed - a payment is then built out of a vault not started. */
    await expect(payPubliclyFromCompanyVault(doorsFor(log, [true], notStarted), order())).rejects.toThrow(/^No payment can be made out of this vault yet.*this vault has not been started/);
    expect(log).toEqual([]);
  });

  it('A PUBLIC PAYMENT READS THE VAULT ON THIS DEVICE, AND THE SERVICE IS NEVER ASKED WHAT THE VAULT HOLDS', async () => {
    const log: string[] = [];
    const asked = { n: 0 };
    /* RED WHEN: the public payment reads the vault through the service's chain route. */
    await payPubliclyFromCompanyVault(theServiceNeverAsked(doorsFor(log, [false, true]), asked), order());
    expect(log).toContain('sent public payout');
    expect(asked.n).toBe(0);
  });

  it('A FAILURE AFTER THE SEND IS NEVER REPORTED AS A PAYMENT THAT DID NOT HAPPEN', async () => {
    const log: string[] = [];
    /* RED WHEN: an account that never records the payment is read as the payment not having been made. */
    const e = await payPubliclyFromCompanyVault(doorsFor(log, [false]), order()).catch((x) => x);
    expect(e).toBeInstanceOf(PublicPaymentNotYetSeen);
    expect(e.message).toMatch(/^the payment may have been sent \(u\) and this device has not seen it land, so it may still land\. Do not pay this person again/);
    /* A refusal before anything was sent says so, and is not dressed up as a payment that may have moved. */
    const refused = Object.assign(new Error('this is not a public payment. Nothing was sent.'), { nothingWasSent: true });
    await expect(payPubliclyFromCompanyVault(doorsFor([], [true], { payoutPublicly: async () => { throw refused; } }), order()))
      .rejects.toBe(refused);
    const lost = await payPubliclyFromCompanyVault(
      doorsFor([], [true], { payoutPublicly: async () => { throw new Error('the socket closed'); } }), order()).catch((x) => x);
    /* RED WHEN: a send that may have reached the chain is reported as nothing sent. */
    expect(lost).toBeInstanceOf(PublicPaymentNotYetSeen);
  });
});

describe('A NEW VAULT\'S NAME AND DESCRIPTION, FILED ONCE THIS DEVICE HAS READ IT AS THE COMPANY\'S', () => {
  const COMPANY_KEY = '44'.repeat(32) as Hex;
  /** The company's records the vault's name is filed in, as a store that logs what reaches it. */
  const infoRecords = (log: string[], over: { kept?: SealedCompanyRecord[]; refuse?: boolean } = {}) => {
    const kept: SealedCompanyRecord[] = over.kept ?? [];
    return {
      kept,
      records: {
        get: async () => kept[kept.length - 1] ?? null,
        served: async () => kept[kept.length - 1] ?? null,
        put: async (rec: SealedCompanyRecord) => {
          log.push(`filed the vault's name v${rec.version}`);
          if (over.refuse === true) throw new Error('the service is down');
          kept.push(signCompanyFiling(rec, '11'.repeat(32) as Hex));
        },
      },
    };
  };
  /** Creating a vault as `role`, the company's directory as this seat's device believes it. */
  const creating = async (log: string[], role: 'admin' | 'approver' | null, records?: ReturnType<typeof infoRecords>['records']) => {
    const doors = await filedAlready();
    const kept = proposalsKeptInATest({ signingSecret: '11'.repeat(32) as Hex, role });
    const directory = async () => ({ ...(await kept.doors.directory()), another: new Set(), holders: { seats: ['ada'] } }) as never;
    return { ...doors, proposals: { ...kept.doors, directory }, ...(records === undefined ? {} : { vaultInfo: records }), log: kept.log };
  };
  const create = (doors: Awaited<ReturnType<typeof creating>>, log: string[], resume?: Hex, info?: { name: string; description: string }) =>
    createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: builder(log) }, resume, info);

  it('IS FILED ONCE THIS DEVICE HAS READ THE NEW VAULT AS THE COMPANY\'S, BY THE SEAT THAT CREATES IT, AND EVERY SIGNER OPENS IT', async () => {
    const log: string[] = [];
    const info = infoRecords(log);
    const doors = await creating(log, 'admin', info.records);
    const done = await create(doors, log, undefined, { name: 'Payroll UK', description: 'Pays the London team.' });
    /* RED WHEN: the name not being filed stops the vault, or is said when it was filed. */
    expect(done).toEqual({ vault: VAULT, state: 'started' });
    /*
     * RED WHEN: the name is filed before the vault is sent or before this device has read it as born held by the company,
     * or after the start rather than right after that read.
     */
    expect(log.slice(0, 4)).toEqual([expect.stringMatching(/^build vault/u), 'sent deploy', expect.stringMatching(/^read the deploy/u), 'filed the vault\'s name v1']);
    /* RED WHEN: the version filed is not under the vault's address, or is not entered in the company's records. */
    expect(info.kept[0]!.id).toBe(VAULT);
    expect(doors.log).toContain(`entered ${VAULT}`);
    /* RED WHEN: the record is sealed to anything but the company's key every seat holds. */
    expect(openVaultInfo(info.kept[0]!, COMPANY_KEY)).toEqual({ name: 'Payroll UK', description: 'Pays the London team.' });
  });

  it('A VAULT THIS DEVICE DOES NOT READ AS THE COMPANY\'S, OR HAS NOT SEEN ON THE CHAIN, IS NEVER NAMED', async () => {
    const log: string[] = [];
    const info = infoRecords(log);
    const doors = await creating(log, 'admin', info.records);
    const notBorn = { ...builder(log), vaultAsDeployed: async () => ({ refusal: 'this is not a vault this company can use: held by other keys. Nothing was sent.' }) };
    const e = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: notBorn },
      undefined, { name: 'Payroll UK', description: '' }).catch((x) => x);
    expect(e).toBeInstanceOf(VaultNotTheCompanys);
    /* RED WHEN: a vault this device does not believe is the company's is given a name in the company's records. */
    expect(info.kept).toEqual([]);
    expect(log).not.toContain('filed the vault\'s name v1');
    const unseen: string[] = [];
    const none = infoRecords(unseen);
    const later = await creating(unseen, 'admin', none.records);
    const owed = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...later, account: ACCOUNT, service: serviceFrom([view({ onChain: false })], unseen), builder: builder(unseen) },
      undefined, { name: 'Payroll UK', description: '' }).catch((x) => x);
    expect(owed).toBeInstanceOf(VaultStartOwed);
    /* RED WHEN: a vault the chain has not shown yet is named before this device has read it. */
    expect(none.kept).toEqual([]);
  });

  it('A VAULT NOT BUILT SAYS WHICH CHECK REFUSED IT, BEFORE ANYTHING IS SENT', async () => {
    const log: string[] = [];
    const doors = await creating(log, 'admin', infoRecords(log).records);
    const press = (over: Partial<Parameters<typeof createCompanyVault>[0]>) =>
      createCompanyVault({ ...pacing, ...walletReadsTheVault, ...doors, account: ACCOUNT, service: serviceFrom([held], log), builder: builder(log), ...over }).catch((x) => x);
    const onChain = walletReadsTheVault.onChain;
    /* RED WHEN: a wallet that cannot say who holds the account is refused as a plain error with no kind. */
    expect(await press({ onChain: async () => { throw new Error('the wallet is closed'); } })).toMatchObject({ name: 'VaultNotBuilt', code: 'committee-unread' });
    /* RED WHEN: an account whose committee cannot hold a vault is refused as a plain error with no kind. */
    const empty = async (v: string) => ({ holders: { ...(await onChain(v)).holders, committee: [], threshold: 0 } });
    expect(await press({ onChain: empty })).toMatchObject({ name: 'VaultNotBuilt', code: 'committee-not-installable' });
    /* RED WHEN: a page that cannot build a held vault is refused as a plain error with no kind. */
    expect(await press({ builder: { ...builder(log), bornHeldVault: undefined } })).toMatchObject({ name: 'VaultNotBuilt', code: 'page-out-of-date' });
    expect(log.filter((l) => l === 'sent deploy')).toEqual([]);
    /* RED WHEN: a wallet that goes quiet after the vault was sent is said as "no vault was built", and the vault is not named as one whose set-up is owed. */
    log.length = 0;
    let reads = 0;
    const quiet = await press({ onChain: async (v: string) => { reads += 1; if (reads > 1) throw new Error('the wallet is closed'); return onChain(v); } });
    expect(quiet).toBeInstanceOf(VaultStartOwed);
    expect(log).toContain('sent deploy');
    /* RED WHEN: a throw after the vault was sent - the wallet's indexer ask, or the read of how the vault was created - reaches the page as a plain refusal that names no vault, so pressing Create again deploys a second one. */
    for (const [why, over] of [
      ['the wallet window was closed', { indexer: async () => { throw new Error('the wallet window was closed'); } }],
      ['the worker failed', { builder: { ...builder(log), vaultAsDeployed: async () => { throw new Error('the worker failed'); } } }],
    ] as const) {
      log.length = 0;
      const after = await press(over as never);
      expect(after, why).toBeInstanceOf(VaultStartOwed);
      expect(after, why).toMatchObject({ vault: VAULT });
      expect(log, why).toContain('sent deploy');
    }
  });

  it('A NAME THE CHECK REFUSES STOPS THE PRESS BEFORE ANYTHING IS BUILT OR SENT', async () => {
    const log: string[] = [];
    const doors = await creating(log, 'admin', infoRecords(log).records);
    /* RED WHEN: a name over 64 characters is found only after the vault is deployed. */
    await expect(create(doors, log, undefined, { name: 'x'.repeat(65), description: '' })).rejects.toThrow(/No vault was built: .*Nothing was sent\./u);
    expect(log).toEqual([]);
  });

  it('A NAME NOT FILED DOES NOT STOP THE VAULT: IT IS CREATED UNNAMED AND WHY IS SAID', async () => {
    const log: string[] = [];
    const info = infoRecords(log);
    const approver = await creating(log, 'approver', info.records);
    const done = await create(approver, log, undefined, { name: 'Payroll', description: '' });
    /* RED WHEN: a seat whose role may not file the name files it, or its press stops the vault. */
    expect(done.state).toBe('started');
    expect(done.said).toEqual([expect.stringMatching(/^This vault was created without its name and description: your seat's role .* may not name/u)]);
    /* RED WHEN: a name not filed is said only as an English sentence, with no kind the page can word. */
    expect(done.saidCodes).toEqual(['vault-name-not-filed']);
    expect(info.kept).toEqual([]);
    expect(log).not.toContain('filed the vault\'s name v1');
    const down: string[] = [];
    const refused = await create(await creating(down, 'admin', infoRecords(down, { refuse: true }).records), down, undefined, { name: 'Payroll', description: '' });
    /* RED WHEN: a service that refuses the name stops the vault, or the refusal goes unsaid. */
    expect(refused.state).toBe('started');
    expect(refused.said).toEqual([expect.stringMatching(/without its name and description: .*the service is down/u)]);
    expect(refused.saidCodes).toEqual(['vault-name-not-filed']);
  });

  it('A RESUMED PRESS FILES THE NAME ONLY IF THE VAULT HAS NONE, AND ENTERS AGAIN ITS OWN', async () => {
    const log: string[] = [];
    const theirs = signCompanyFiling(sealVaultInfo({ company: 'acc_1', vault: VAULT, version: 1, keyEpoch: 0, key: COMPANY_KEY, info: { name: 'Given by Bo', description: '' } }), '77'.repeat(32) as Hex);
    const named = infoRecords(log, { kept: [theirs] });
    const done = await create(await creating(log, 'admin', named.records), log, VAULT, { name: 'Payroll', description: '' });
    /* RED WHEN: a resume writes over a name another admin already gave the vault. */
    expect(named.kept).toEqual([theirs]);
    expect(done.said).toEqual(['This vault already has a name, given before this press, so the one given here was not filed.']);
    /* RED WHEN: a name another admin already gave is said as a name that could not be filed. */
    expect(done.saidCodes).toEqual(['vault-name-given-before']);
    const again: string[] = [];
    const mine = infoRecords(again);
    const first = await creating(again, 'admin', mine.records);
    await create(first, again, undefined, { name: 'Payroll', description: '' });
    const resumed = await creating(again, 'admin', mine.records);
    const twice = await create(resumed, again, VAULT, { name: 'Payroll', description: '' });
    /* RED WHEN: a resume of the same press files the same name a second time instead of entering the first again. */
    expect(mine.kept).toHaveLength(1);
    expect(twice.said).toBeUndefined();
    expect(twice.saidCodes).toBeUndefined();
    expect(resumed.log).toContain(`entered ${VAULT}`);
  });
});

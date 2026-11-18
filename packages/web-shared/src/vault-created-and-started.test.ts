import { START_STOP } from './vault-start-stops.js';
import { anUnsetNewerSecret } from './vault-operation.test-support.js';
import { START_READ_STOP, VaultNotTheCompanys, VaultStartOwed } from './vault-start-stops.js';
import { type SecretReaderSources } from './vault-doors.js';
import { type VaultService } from './vault-service.js';
import { createCompanyVault } from './vault-created-and-started.js';
import { type Hex, toHex } from '../../../src/core/crypto.js';
import { ReadRanOutOfTime, SERVICE_READ_BOUND_MS } from './read-bound.js';
import { type SealedCompanyRecord, signCompanyFiling } from '../../../src/midnight/sealed-record-wire.js';
import { type VaultBuilderClient, type VaultOnChainOnTheWire } from './vault-worker-client.js';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { openNonceSecrets, recordsKeypairFrom, startNonceSecret } from '../../../src/midnight/company-nonce-secret.js';
import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { openVaultInfo, sealVaultInfo } from '../../../src/midnight/vault-info-record.js';
import { proposalsKeptInATest } from './a-vaults-start-proposals.test-support.js';
import { recordsReaderOf } from './deposit-on-device.js';
import { sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { ACCOUNT, ADAS, CURRENT_CHAIN, LABEL, type TestView, VAULT, aServiceThatLies, adasDirectory, builder, chains, committee, filedAlready, held, newestSecretIn, pacing, readOnTheDevice, serviceFrom, startDoors, theServiceNeverAsked, view, walletKey, walletRead, walletReadsTheVault } from './vault-operation.test-support.js';



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
        return { e, log, filed: await doors.records('nonce-secret').get(VAULT), mine, companyKey: doors.me.companyKey };
      };

      it('a key the service slips onto its list is never a reader: the secret is sealed to the keys the directory names', async () => {
        const { filed, mine, companyKey } = await pressUnfiled((m) => [m, another]);
        expect(filed).not.toBeNull();
        const readers = openNonceSecrets(filed!, VAULT, recordsKeypairFrom(companyKey)).readers.map((k) => String(k).toLowerCase());
        /* RED WHEN: a new vault's secret is sealed to the readers the service lists, so a key the directory does not name opens it. */
        expect(readers).not.toContain(another.toLowerCase());
        expect(readers).toEqual([mine.toLowerCase()]);
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

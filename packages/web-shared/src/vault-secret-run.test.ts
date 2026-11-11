import { runFor } from '../../../src/midnight/vault-start.js';
import { type FirstSecretShown, MOST_READER_NAME } from 'midnight-identity/profile/request';
import { type Hex, type Sealed, fromHex, parseCanonical, signingPublicKeyOf, toHex, unseal } from '../../../src/core/crypto.js';
import { MemorySealedPoolStore } from '../../../src/midnight/vault-pool.js';
import { NO_ASSET } from '../../../src/core/assets.js';
import { READER_REFUSAL } from '../../../src/midnight/secret-readers.js';
import { ReadRanOutOfTime } from './read-bound.js';
import { START_STOP, type SecretReaderSources, StartRoundRefused, type VaultCreated, approveStartRoundHere, carryStartRoundHere, createCompanyVault, depositIntoCompanyVault, finishedSecretRunHere, openCompanyVaultPool, raiseASecretRunHere, startRoundOpenedHere } from './vault-operation.js';
import type { SealedProposal } from '../../../src/core/types.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import type { WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import { approverRosterFrom, EVERY_RIGHT } from '../../../src/core/vault-approvers.js';
import { committeeKeyFor } from 'midnight-identity/profile/committee-key';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { noOtherRunStanding, startRecordOpened } from './vault-secret-run-record.js';
import { openNonceSecrets, recordsKeypairFrom, startNonceSecret } from '../../../src/midnight/company-nonce-secret.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import { openSecretCopy, sealSecretCopy } from '../../../src/midnight/sealed-secret-copy.js';
import { proposalsKeptInATest } from './a-vaults-start-proposals.test-support.js';
import { raiseByOf, sealGovernanceProposal, sealVaultSecretProposal, signProposalFiling } from '../../../src/core/proposal-filing.js';
import { signRecordsKey } from 'midnight-identity/profile/records-key';
import { ACCOUNT, ADAS, LABEL, type TestView, VAULT, adasDirectory, anUnsetNewerSecret, builder, committee, hereAndThere, inFlightInMemory, newestSecretIn, nothingToCheck, pacing, readOnTheDevice, serviceFrom, startDoors, view, walletKey, walletRead, walletReadsTheVault } from './vault-operation.test-support.js';


/*
 * The vault's committee and its secret, each held to what the chain shows and never to what the service says alone.
 * A company of one: Ada's wallet signed her records key for her seat, and the chain lists her committee key.
 */
describe('THE VAULT\'S COMMITTEE AND ITS SECRET, FROM THE CHAIN', () => {
  const identity = identityFromSecret(new Uint8Array(32).fill(1));
  const committeeKey = committeeKeyFor(identity, LABEL) as { tag: string; value: string };
  const temporary = { tag: 'schnorr', value: walletKey(0x77) };
  const sealed = (secret: string, reader: string) => sealSecretCopy({ vault: VAULT, secret, reader }).map((p) => toHex(p));
  /* Ada's own doors, her wallet read stood in by `reads`, one answer per check in order, the last repeated. */
  const ada = (reads: Array<ReturnType<typeof walletRead> | null>, asked: string[]) => {
    const doors = startDoors();
    const statement = signRecordsKey(identity, LABEL, ACCOUNT, doors.me.companyKey, ADAS.seat);
    let n = 0;
    const secretReaders: SecretReaderSources = {
      company: LABEL,
      read: async (v) => { asked.push(`wallet read ${v.slice(0, 4)}`); return reads[Math.min(n++, reads.length - 1)]!; },
      roster: async () => [{
        signerId: 'ada', userId: 'ada', name: 'Ada', filingKey: '00'.repeat(32) as never,
        keys: {
          committeeKey, recordsKey: statement.recordsKey as never,
          recordsKeyStatement: statement.signature as never, recordsKeySeat: statement.seat as never,
        },
      }],
      directory: adasDirectory,
    };
    return { ...doors, secretReaders, mine: recordsKeypairFrom(doors.me.companyKey).publicKey };
  };
  /*
   * A chain that has adopted the vault and holds no secret yet. A run is open on the account only for the secret
   * `openRunFor` names; `holds` is the secret whose commitment the vault holds, if any. Each standing asked with a
   * secret is logged with that secret, and with `raise` when it is asked with a window, which only a raise does.
   */
  const chainBuilder = (log: string[], chain: { openRunFor?: string; holds?: string; runInWindow?: boolean; runOpen?: boolean; runBeforeARemoval?: boolean; staleAdoption?: boolean; unadopted?: boolean }) => (): VaultBuilderClient => ({
    ...builder(log),
    governedCall: async (i) => { log.push(`built ${i.order.circuit}`); throw new Error('stand-in: nothing is proved here'); },
    startStanding: async (i) => {
      if (i.secret !== undefined) log.push(`standing with ${i.secret.slice(0, 8)}${i.window === undefined ? '' : ' raise'}`);
      const mine = (i.readers ?? [])[0] ?? '';
      return {
        standing: {
          adopted: chain.staleAdoption !== true && chain.unadopted !== true, removals: 0,
          adoption: { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32), open: chain.staleAdoption === true, approvals: 0, needed: 1, stale: chain.staleAdoption === true, approvedHere: false },
          ...(i.secret === undefined ? {} : {
            secret: {
              set: chain.holds === i.secret, another: chain.holds !== undefined && chain.holds !== i.secret,
              held: '00'.repeat(32), landed: [], rootIsThisRuns: true, written: [false], started: false,
              run: chain.openRunFor === i.secret ? {
                proposal: 'b1'.repeat(32), payload: 'b2'.repeat(32), named: 'b3'.repeat(32), salt: 'b4'.repeat(32),
                open: chain.runOpen ?? true, approvals: 0, needed: 1, stale: false, approvedHere: false, opensAt: '1', closesAt: '2', inWindow: chain.runInWindow ?? true,
                beforeARemoval: chain.runBeforeARemoval ?? false,
              } : null,
              ...(i.window === undefined ? {} : {
                raise: { proposal: 'b7'.repeat(32), payload: 'b8'.repeat(32), named: 'b9'.repeat(32), salt: 'ba'.repeat(32), opensAt: '1', closesAt: '2' },
              }),
            },
          }),
        },
        ...(i.secret === undefined ? {} : { run: { root: 'b5'.repeat(32), payees: '1', asset: 'b6'.repeat(32), copies: [{ reader: mine, parts: sealed(i.secret, mine), path: [] }] } as never }),
      };
    },
  });
  const heldByThem = view({ heldByCommittee: true, authority: { committee: [committeeKey], threshold: 1, counter: '1', shape: 'committee' } });
  const press = async (
    a: ReturnType<typeof ada>, log: string[], chain: { openRunFor?: string; holds?: string; runInWindow?: boolean; runOpen?: boolean; runBeforeARemoval?: boolean; staleAdoption?: boolean; unadopted?: boolean }, served: TestView = heldByThem,
  ) => {
    const service = serviceFrom([served], log, { keys: async () => ({ committee, why: null, readers: [a.mine] }) });
    return createCompanyVault({
      ...pacing, ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder: chainBuilder(log, chain)(),
    }, VAULT).catch((x) => x);
  };
  const newest = async (a: ReturnType<typeof ada>) => {
    const rec = (await a.records('nonce-secret').get(VAULT))!;
    return { version: rec.version, secret: openNonceSecrets(rec, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]! };
  };

  describe('THE READERS ARE CHECKED AGAINST WHAT THE SIGNER\'S OWN WALLET READ, AND NO COMMITTEE IS', () => {
    /* RED WHEN: the reader check reads which committee holds the vault - the super admins' own system - and stops on it. */
    it('the wallet reads the vault held by a key that is not the account\'s: no reader\'s concern, the secret is filed and raised', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey, [temporary])], log);
      const e = await press(a, log, {});
      expect(e.stoppedAt).toBeUndefined();
      expect(await a.records('nonce-secret').get(VAULT)).not.toBeNull();
      expect(log).toContain('built propose');
    });

    /* RED WHEN: the service's report of who holds the vault is used - here it names a temporary key and the wallet's read is good. */
    it('the service\'s report and the wallet\'s read differ: the wallet\'s read wins', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const misreported = view({ heldByCommittee: true, authority: { committee: [temporary], threshold: 1, counter: '0', shape: 'one-key' } });
      const e = await press(a, log, {}, misreported);
      /* Past both reader checks: a secret was filed and the run was raised from it. */
      expect(await a.records('nonce-secret').get(VAULT)).not.toBeNull();
      expect(log).toContain('built propose');
      expect(e.message).toMatch(/raising its first secret could not be built/);
    });

    /* RED WHEN: one wallet read is shared by the check before filing and the check before the run. */
    it('each of the two checks in one press asks the wallet afresh, and the second refuses what changed after the first', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey), walletRead(committeeKey, [committeeKey], ['ff'.repeat(32)])], log);
      const e = await press(a, log, {});
      expect(log.filter((l) => l.startsWith('wallet read'))).toEqual([`wallet read ${VAULT.slice(0, 4)}`, `wallet read ${VAULT.slice(0, 4)}`]);
      /* The first check passed and the secret was filed; the second read sees Ada's seat no longer held, and nothing is raised. */
      expect(await a.records('nonce-secret').get(VAULT)).not.toBeNull();
      expect(e.stoppedAt).toBe('seat-not-held');
      expect(log.filter((l) => l.startsWith('built'))).toEqual([]);
    });

    /* RED WHEN: the wallet is asked before a first secret without being shown the vault and every reader, named as this page holds them. */
    it('every check before the first secret shows the wallet the vault and each reader with the name the company\'s roster gives', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const shown: unknown[] = [];
      const reads = a.secretReaders.read;
      a.secretReaders = { ...a.secretReaders, read: async (v, firstSecret) => { shown.push({ v, firstSecret }); return reads(v, firstSecret); } };
      await press(a, log, {});
      expect(shown.length).toBe(2);
      for (const s of shown) expect(s).toEqual({ v: VAULT, firstSecret: { readers: [{ key: a.mine, name: 'Ada' }] } });
      /* RED WHEN: a name longer than a wallet shows is sent whole, so the wallet refuses the ask and the vault cannot be set up. */
      const long: unknown[] = [];
      const b = ada([walletRead(committeeKey)], []);
      const roster = await b.secretReaders.roster();
      b.secretReaders = {
        ...b.secretReaders, roster: async () => roster.map((e) => ({ ...e, name: 'x'.repeat(MOST_READER_NAME + 100) })),
        read: async (v, firstSecret) => { long.push(firstSecret); return walletRead(committeeKey); },
      };
      await press(b, [], {});
      expect((long[0] as FirstSecretShown).readers[0]?.name).toBe('x'.repeat(MOST_READER_NAME));
    });

    /* RED WHEN: a check with no reader to show sends the wallet an empty list it refuses, hiding why the start stopped. */
    it('with no reader the directory names, the wallet is asked plainly and the reader check says what is missing', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const shown: unknown[] = [];
      const reads = a.secretReaders.read;
      const directory = a.secretReaders.directory;
      a.secretReaders = {
        ...a.secretReaders, read: async (v, firstSecret) => { shown.push(firstSecret); return reads(v, firstSecret); },
        directory: async () => ({ ...(await directory()), readers: [] }),
      };
      const service = serviceFrom([heldByThem], log, { keys: async () => ({ committee, why: null, readers: [] }) });
      const e = await createCompanyVault({
        ...pacing, ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder: chainBuilder(log, {})(),
      }, VAULT).catch((x) => x);
      expect(shown).toEqual([undefined]);
      expect(e.message).toMatch(/the list of seats the company's directory believes does not have the key your own recovery words give/u);
      expect(log.filter((l) => l.startsWith('built ') || l.startsWith('sent '))).toEqual([]);
    });

    it('a wallet that cannot be asked stops the press as the wallet\'s, before anything is filed', async () => {
      const log: string[] = [];
      const a = ada([null], log);
      a.secretReaders = { ...a.secretReaders, read: async () => { throw new Error('the person closed the wallet'); } } as SecretReaderSources;
      const e = await press(a, log, {});
      expect(e.stoppedAt).toBe(START_STOP.walletNotAnswered);
      expect(e.message).toMatch(/your wallet did not say who holds the company and this vault \(the person closed the wallet\)/);
      expect(await a.records('nonce-secret').get(VAULT)).toBeNull();
    });

    /* RED WHEN: a directory that cannot be read is filed under the wallet's kinds of stop, or under none. */
    it('a directory that cannot be read stops the press as the directory\'s, and files nothing', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      a.secretReaders = { ...a.secretReaders, directory: async () => { throw new Error('the service did not answer'); } } as SecretReaderSources;
      const e = await press(a, log, {});
      expect(e.stoppedAt).toBe(READER_REFUSAL.directoryUnread);
      expect(await a.records('nonce-secret').get(VAULT)).toBeNull();
    });

    /* RED WHEN: a stop that pressing again can never clear carries no kind, so the page offers to finish it. */
    it('an adoption raised before a signer changed stops the press as lasting, and nothing is sent', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const e = await press(a, log, { staleAdoption: true });
      expect(e.name).toBe('VaultStartOwed');
      expect(e.stoppedAt).toBe(START_STOP.adoptionStale);
      /* RED WHEN: the words lead the person to withdraw the adoption and raise it again, which no earlier approver could then approve. */
      expect(e.message).not.toMatch(/raised again/u);
      expect(e.message).toMatch(/create a new vault instead/u);
      expect(log.filter((l) => l.startsWith('built'))).toEqual([]);
    });

    /* RED WHEN: approvers who would leave the vault short stop the press without a kind of their own. */
    it('too few approvers stop the press as that, and nothing is sent', async () => {
      const log: string[] = [];
      const a = { ...ada([walletRead(committeeKey)], log), approvers: async () => approverRosterFrom({
        threshold: 2, vaultThresholds: [], seated: [{ leaf: 'e1', rights: EVERY_RIGHT }], adoptedVaults: [], companyWide: 'cc'.repeat(32),
      }) };
      const e = await press(a, log, { unadopted: true });
      expect(e.name).toBe('VaultStartOwed');
      expect(e.stoppedAt).toBe(START_STOP.tooFewApprovers);
      expect(log.filter((l) => l.startsWith('built'))).toEqual([]);
    });
  });

  describe('A NONCE SECRET IS USED ONLY WHEN THE CHAIN VOUCHES FOR IT', () => {
    /* RED WHEN: the device that files a secret builds the run from what the route hands back. */
    it('a secret the service substitutes before any run, wrapped correctly to this device, is never used', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      /* The route files what it is given and hands back a record of the service's own, wrapped to Ada's key. */
      const theirs = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
      const X = openNonceSecrets(theirs, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
      const store = a.records('nonce-secret');
      let filed = false;
      const put = store.put.bind(store);
      store.put = async (v, r) => { filed = true; await put(v, r); };
      const get = store.get.bind(store);
      store.get = async (v) => (filed ? theirs : get(v));
      const e = await press(a, log, {});
      const used = log.filter((l) => l.startsWith('standing with')).map((l) => l.slice('standing with '.length, 'standing with '.length + 8));
      expect(used.length).toBeGreaterThan(0);
      expect(used, 'RED WHEN: the substituted secret reaches the run').not.toContain(X.slice(0, 8));
      /* And the records no longer holding what this device made, nothing is raised from either. */
      expect(log).not.toContain('built propose');
      expect(e.message).toMatch(/records no longer hold the secret this device was about to use, so its first secret run was not sent/);
    });

    /* RED WHEN: a device sets a secret the records no longer hold as their newest - this app's devices would then build no deposit into the vault. */
    it('a secret another device replaced after this one raised its run is not set', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const raised = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
      await a.records('nonce-secret').put(VAULT, raised);
      const S = openNonceSecrets(raised, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
      /* The run made from S is open and has its approvals; meanwhile another device filed a fresh secret over S. */
      const store = a.records('nonce-secret');
      const get = store.get.bind(store);
      let reads = 0;
      store.get = async (v) => (reads++ < 2 ? get(v) : startNonceSecret(VAULT, [{ publicKey: a.mine }]));
      const build = chainBuilder(log, { openRunFor: S })();
      const approved: VaultBuilderClient = {
        ...build,
        startStanding: async (i) => {
          const st = await build.startStanding(i);
          const run = st.standing.secret?.run;
          return run ? { ...st, standing: { ...st.standing, secret: { ...st.standing.secret!, run: { ...run, approvals: 1 } } } } : st;
        },
        setNonceSecret: async () => { log.push('built set'); return { tx: 'S' }; },
      };
      const service = serviceFrom([heldByThem], log, { keys: async () => ({ committee, why: null, readers: [a.mine] }) });
      const e = await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder: approved }, VAULT)
        .catch((x) => x);
      expect(log).not.toContain('built set');
      expect(e.message).toMatch(/records no longer hold the secret this device was about to use, so its first secret was not sent/);
    });

    /* RED WHEN: a filed secret that no run and no commitment vouches for is raised from rather than replaced. */
    it('a later press that finds a filed secret with no run on the chain makes a fresh one, files it and raises from it', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const earlier = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
      await a.records('nonce-secret').put(VAULT, earlier);
      const X = openNonceSecrets(earlier, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
      const e = await press(a, log, {});
      const now = await newest(a);
      expect(now.version).toBe(2);
      expect(now.secret).not.toBe(X);
      /* The read-back secret is only looked at; the raise is made from the fresh one. */
      expect(log.filter((l) => l.endsWith(' raise'))).toEqual([`standing with ${now.secret.slice(0, 8)} raise`]);
      expect(log).toContain('built propose');
      expect(e.message).toMatch(/raising its first secret could not be built/);
      /* Two checks of the readers: before the fresh secret is filed, and before the run. */
      expect(log.filter((l) => l.startsWith('wallet read'))).toHaveLength(2);
    });

    /* RED WHEN: the fresh secret is made and filed from a read of the vault that cannot be relied on, because the start read works out pinned on its own. */
    it('a later press whose second read of the vault is not laid out as this build\'s makes no fresh secret and files nothing', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const earlier = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
      await a.records('nonce-secret').put(VAULT, earlier);
      const service = serviceFrom([heldByThem], log, { keys: async () => ({ committee, why: null, readers: [a.mine] }) });
      const real = chainBuilder(log, {})();
      let reads = 0;
      /* The pool is opened on the first read; the second is the one the fresh secret is made on. */
      const builder = { ...real, vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) => {
        reads += 1;
        const got = await real.vaultOnChain(i);
        return reads >= 2 ? { ...got, notesFromThisBuild: false, notesWhy: 'a field is missing' } as never : got;
      } };
      const e = await createCompanyVault({
        ...pacing, ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder,
      }, VAULT).catch((x) => x);
      expect(e.message).toMatch(/not laid out the way this version of the product reads one/);
      expect((await a.records('nonce-secret').get(VAULT))!.version).toBe(1);
      expect(log.filter((l) => l.startsWith('built'))).toEqual([]);
    });

    /* RED WHEN: a second signer's honest read-back is replaced, splitting the signers between two secrets. */
    it('a read-back secret an open run of the signers commits to is approved, not replaced', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      const raised = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
      await a.records('nonce-secret').put(VAULT, raised);
      const S = openNonceSecrets(raised, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
      const e = await press(a, log, { openRunFor: S });
      expect((await newest(a)).version).toBe(1);
      expect(log).toContain('built approve');
      expect(log).not.toContain('built propose');
      expect(e.message).toMatch(/approving its first secret could not be built/);
    });

    /* RED WHEN: a run that can no longer be approved - closed, outside its window, or raised before a removal - is taken as vouching for the secret it was made from. */
    it('a read-back secret whose run is closed, outside its window or raised before a removal is replaced, not raised from again', async () => {
      for (const [why, chain] of [['outside its window', { runInWindow: false }], ['closed', { runOpen: false }], ['raised before a removal', { runBeforeARemoval: true }]] as const) {
        const log: string[] = [];
        const a = ada([walletRead(committeeKey)], log);
        const raised = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
        await a.records('nonce-secret').put(VAULT, raised);
        const S = openNonceSecrets(raised, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
        await press(a, log, { openRunFor: S, ...chain });
        const now = await newest(a);
        expect(now.version, why).toBe(2);
        expect(log.filter((l) => l.endsWith(' raise')), why).toEqual([`standing with ${now.secret.slice(0, 8)} raise`]);
      }
    });

    /* RED WHEN: a read-back secret the vault does not hold is carried on with after the run landed. */
    it('a secret the service substitutes after the run landed is refused, and nothing is sent', async () => {
      const log: string[] = [];
      const a = ada([walletRead(committeeKey)], log);
      await a.records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [{ publicKey: a.mine }]));
      const e = await press(a, log, { holds: 'ee'.repeat(31) + '00' });
      expect(e.name).toBe('VaultStartOwed');
      expect(e.message).toMatch(/already holds a secret other than the one the company's records hold/);
      expect(e.stoppedAt).toBe(START_STOP.anotherSecret);
      expect((await newest(a)).version).toBe(1);
      expect(log.filter((l) => l.startsWith('built'))).toEqual([]);
    });
  });

  describe('A DEPOSIT AND A PAYMENT ARE MADE ONLY UNDER THE SECRET THE VAULT HOLDS', () => {
    const wrapping = recordsKeypairFrom(new Uint8Array(32).fill(6));
    const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(6) };
    /* RED WHEN: a deposit chooses a coin under a secret the vault's commitment does not name. */
    it('a deposit under a secret the vault does not hold is refused before a coin is chosen or a line filed', async () => {
      const log: string[] = [];
      const s = new Map<WireRecord, MemorySealedPoolStore>();
      const records = (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
      const ready = view({ heldByCommittee: true, started: true, state: 'QUJD', notes: [], everCreated: [] });
      const doors = {
        ...pacing, ...walletReadsTheVault, ...hereAndThere(serviceFrom([ready], log)), builder: { vaultOnChain: readOnTheDevice }, me, myRecordsKey: 'ff'.repeat(32), records,
        signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
      };
      await openCompanyVaultPool(doors, VAULT, nothingToCheck);
      const asked: string[] = [];
      const e = await depositIntoCompanyVault({
        ...doors, company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(),
        builder: { ...builder(log), secretIsTheVaults: async (i) => { asked.push(i.state); return false; } },
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch((x: Error) => x);
      expect((e as Error).message).toMatch(/not the one the vault holds on the chain.*Nothing is filed or deposited/);
      /* Asked of the very state the deposit would be built against, by the step that makes the chain's secret the records' newest and by the deposit's own check. */
      expect(asked.length).toBeGreaterThan(0);
      expect(new Set(asked)).toEqual(new Set(['QUJD']));
      expect(log.filter((l) => l.startsWith('build') || l === 'paid')).toEqual([]);
      expect(await records('deposit-journal').get(VAULT)).toBeNull();
    });

    it('THE CHAIN WINS BEFORE A DEPOSIT CHOOSES ITS COIN: A NEWER SECRET THE VAULT NEVER TOOK IS PASSED OVER FOR THE ONE IT HOLDS', async () => {
      const log: string[] = [];
      const s = new Map<WireRecord, MemorySealedPoolStore>();
      const records = (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
      const ready = view({ heldByCommittee: true, started: true, state: 'QUJD', notes: [], everCreated: [] });
      const doors = {
        ...pacing, ...walletReadsTheVault, ...hereAndThere(serviceFrom([ready], log)), builder: { vaultOnChain: readOnTheDevice }, me, myRecordsKey: 'ff'.repeat(32), records,
        signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
      };
      await openCompanyVaultPool(doors, VAULT, nothingToCheck);
      const theVaults = await anUnsetNewerSecret(records, me.companyKey);
      await depositIntoCompanyVault({
        ...doors, company: LABEL, account: ACCOUNT, inFlight: inFlightInMemory(),
        builder: { ...builder(log), secretIsTheVaults: async (i) => i.secret === theVaults },
        pay: async () => { log.push('paid'); return { transaction: 'X', leaves: [] }; },
      }, VAULT, { token: 'ab'.repeat(32), value: 7n }).catch(() => undefined);
      /* RED WHEN: a deposit refuses, or chooses its coin, under the records' newest secret when the vault holds an earlier one. */
      expect(log.some((l) => l.startsWith('build deposit'))).toBe(true);
      const newest = (await records('nonce-secret').get(VAULT))!;
      expect([newest.version, newestSecretIn(newest, me.companyKey)]).toEqual([3, theVaults]);
    });
  });

  describe('A NEW VAULT\'S TWO PROPOSALS ARE WRITTEN DOWN BY THE DEVICE THAT RAISES THEM', () => {
    const ADOPTION = { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32) };
    const VIEWING = '44'.repeat(32);
    const opened = (rec: { sealed: unknown }) => {
      const envelope = openRecord<{ kind: string; vault: string; sealedPayload: unknown }>('proposals', 'acc_1', rec.sealed as never, VIEWING);
      return { envelope, body: parseCanonical<Record<string, unknown>>(unseal(envelope.sealedPayload as never, VIEWING)) };
    };
    const DAY = 86_400_000;
    /* As the device's builder does: a raise is built only before the deadline its record sets, and each one built is noted. */
    const raiseOrRefuse = (raiseBy: string | undefined, raisedBy: string[]): void => {
      if (raiseBy === undefined || Date.now() >= Number(raiseBy) * 1000) throw new Error('the chain takes this raise no more');
      raisedBy.push(raiseBy);
    };
    /* Ada's record of the adoption, written down at `createdAt` and sent then, as the service keeps it. */
    const adasAdoptionAt = (createdAt: string, id = 'prp_writtenEarly'): SealedProposal => {
      const f = signProposalFiling('acc_1', {
        id, digest: ADOPTION.payload as Hex, chainId: ADOPTION.proposal as Hex, keyEpoch: 0, createdAt,
        sealed: sealGovernanceProposal({ accountId: 'acc_1', viewingKey: VIEWING as Hex, kind: 'adopt-vault', summary: 'Add a new vault to the company',
          noVault: ADOPTION.named as Hex, body: { vault: VAULT as Hex }, change: { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: ADOPTION.salt as Hex }, proposedBy: 'ada' }),
      }, '11'.repeat(32) as Hex);
      return { ...f, accountId: 'acc_1', status: 'open', approvalCount: 0, txRef: 'T-earlier' };
    };
    /*
     * A chain that holds what reaches it: the adoption opens once its raise is relayed, counted at once as the
     * raiser's own approval (`counted: false` is a chain built before that, which counts none), and is adopted.
     * Ada's wallet then reads nothing, so each press stops right after the adoption. The standing says whether the
     * chain holds this seat's approval, as the account's marker read for this seat does.
     */
    const adoptionPress = (over: { ranOutAfterSend?: boolean; open?: boolean; adopted?: boolean; failSend?: boolean; failEnter?: number; failCarried?: boolean; kept?: SealedProposal[]; role?: 'limited'; needed?: number; notBelieved?: 'unattested' | 'not-on-the-chain'; counted?: boolean; chainTime?: number | null; onTimeRead?: (chain: { open: boolean; approvals: number; adopted: boolean; mine: boolean }) => void } = {}) => {
      const log: string[] = [];
      const chain = { open: over.open ?? false, approvals: 0, adopted: over.adopted ?? false, mine: false };
      const kept = proposalsKeptInATest({
        signingSecret: '11'.repeat(32) as Hex, ...(over.failSend === undefined ? {} : { failSend: over.failSend }),
        ...(over.failEnter === undefined ? {} : { failEnter: over.failEnter }), ...(over.kept === undefined ? {} : { kept: over.kept }),
        ...(over.role === undefined ? {} : { role: over.role }),
        ...(over.notBelieved === undefined ? {} : { notBelieved: over.notBelieved }),
        ...(over.failCarried === undefined ? {} : { failCarried: over.failCarried }),
        onRaise: (id) => { if (id === ADOPTION.proposal) { chain.open = true; if (over.counted !== false) { chain.approvals = 1; chain.mine = true; } } },
      });
      const a = { ...ada([null], log), proposals: kept.doors };
      /* With `ranOutAfterSend`, the first read of the block after a step is sent runs out of time, as on stagenet. */
      const base = builder(log);
      const ran = { out: 0, sent: false };
      const b: VaultBuilderClient = {
        ...base,
        chainAtOneBlock: async (i) => {
          if (over.ranOutAfterSend === true && ran.sent && ran.out === 0) {
            ran.out += 1;
            log.push('the read after the send ran out of time');
            throw new ReadRanOutOfTime('The network (chain-at-one-block)');
          }
          return base.chainAtOneBlock(i);
        },
        governedCall: async (i) => {
          log.push(`built ${i.order.circuit}`);
          if (i.order.circuit === 'propose') raiseOrRefuse(i.opened.raiseBy, raisedBy);
          return { tx: `T-${i.order.circuit}` };
        },
        startStanding: async (i) => ({
          standing: {
            adopted: chain.adopted, removals: 0,
            adoption: {
              ...ADOPTION, open: chain.open, approvals: chain.approvals, needed: over.needed ?? 1, stale: false,
              ...(i.seat === undefined ? {} : { approvedHere: chain.mine }),
            },
          },
        }),
      };
      const service = serviceFrom([heldByThem], log, {
        startAccountCall: async (_v, body) => {
          log.push(`sent ${body.call}`);
          ran.sent = true;
          if (body.call === 'approve') { chain.approvals = 1; chain.mine = true; }
          if (body.call === 'adopt') { chain.adopted = true; chain.open = false; }
          return { txRef: 't' };
        },
        startSecret: async () => { log.push('sent secret'); return { txRef: 't' }; },
        startCopy: async () => { log.push('sent copy'); return { txRef: 't' }; },
      });
      /* The deadline each raise built carried. The chain's time is now unless `chainTime` says otherwise; null is a page that cannot read it. */
      const raisedBy: string[] = [];
      const chainTime = over.chainTime === null ? {} : { chainTime: async () => { over.onTimeRead?.(chain); return over.chainTime ?? Date.now(); } };
      /* A press carrying on the vault, or, given null, creating one. */
      const press = (resume: Hex | null = VAULT as Hex) => createCompanyVault({
        ...pacing, ...(over.ranOutAfterSend === true ? { waitMs: 10 * 60_000, everyMs: 6_000 } : {}),
        ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder: b, ...chainTime,
      }, resume ?? undefined).then((r) => { came = r; return new Error('the press ended without a refusal'); }, (x: unknown) => x as Error);
      /* What the last press came to, when it ended without a refusal. */
      let came: VaultCreated | undefined;
      return { press, log, kept, chain, ran, raisedBy, came: () => came };
    };

    it('a read that runs out of time right after a step is sent is asked again, and the start goes on when the chain shows the step', async () => {
      const without = adoptionPress();
      const expected = await without.press();
      const t = adoptionPress({ ranOutAfterSend: true });
      const e = await t.press();
      /* RED WHEN: the read after the send that ran out of time stops the start, though the chain then shows the step. */
      expect(t.ran.out).toBe(1);
      expect(t.log.indexOf('the read after the send ran out of time')).toBeGreaterThan(t.log.indexOf('sent adopt'));
      expect(t.chain.adopted).toBe(true);
      expect(e.message).toBe(expected.message);
      expect(t.log.filter((l) => l.startsWith('sent '))).toEqual(['sent adopt']);
    });

    it('a new vault\'s adoption is written down by the device that raises it, in the same request as its raise', async () => {
      const t = adoptionPress();
      await t.press();
      /* RED WHEN: the adoption is raised with nothing written down. */
      /* RED WHEN: the adoption the chain carried out is left open in the company's proposals, with no approvals, on every screen. */
      expect(t.kept.log).toEqual(['file and raise', `entered ${t.kept.kept[0]!.id}`, `carried ${t.kept.kept[0]!.id}`]);
      expect(t.kept.kept[0]!.status).toBe('executed');
      expect(t.kept.raised.get(t.kept.kept[0]!.id)).toBe('T-propose');
      expect(t.kept.kept[0]).toMatchObject({ chainId: ADOPTION.proposal, digest: ADOPTION.payload, filedBy: { publicKey: signingPublicKeyOf('11'.repeat(32) as Hex) } });
      expect(t.kept.bodies[0]).toMatchObject({ salt: ADOPTION.salt });
      expect(t.kept.bodies[0]!.vault).toBeUndefined();
      const { envelope, body } = opened(t.kept.kept[0]!);
      expect(envelope).toMatchObject({ kind: 'adopt-vault', vault: ADOPTION.named });
      expect(body).toMatchObject({ vault: VAULT, __change: { salt: ADOPTION.salt } });
      /* RED WHEN: the raiser sends an approval of its own after a raise the chain counted as one, which the chain refuses. Carried out on the start's own route; the raise never went there. */
      expect(t.log.filter((l) => l.startsWith('sent '))).toEqual(['sent adopt']);
      expect(t.log).not.toContain('built approve');
      expect(t.chain.adopted).toBe(true);
    });

    /* RED WHEN: a chain built before the raise counted (open, no approval) is carried out with no approval, or its approval is not sent before the adoption. */
    it('an adoption raised on a chain that did not count the raise is approved by this seat before it is adopted', async () => {
      const t = adoptionPress({ counted: false });
      await t.press();
      expect(t.log.filter((l) => l.startsWith('sent '))).toEqual(['sent approve', 'sent adopt']);
      expect(t.chain.adopted).toBe(true);
    });

    /* RED WHEN: at two approvals needed the raiser builds or sends a second approval of its own, though the chain holds its raise as its approval, or the start goes on to adopt with one. */
    it('with two approvals needed, a raise that counted leaves the raiser building no approval and the start waiting for the other', async () => {
      const t = adoptionPress({ needed: 2 });
      await t.press();
      expect(t.log.filter((l) => l.startsWith('sent '))).toEqual([]);
      expect(t.log).not.toContain('built approve');
      expect(t.came()).toMatchObject({ state: 'awaiting-approvals', awaiting: { round: 'adoption', approvals: 1, needed: 2 } });
      expect(t.chain.adopted).toBe(false);
    });

    it('an adoption the service will not write down as carried out does not stop the start, and a later press writes it down', async () => {
      const first = adoptionPress({ failCarried: true });
      const e = await first.press();
      const id = first.kept.kept[0]!.id;
      /* RED WHEN: a service that will not write the adoption down stops the vault's start, though the chain carried it out. */
      expect(first.kept.log).toEqual(['file and raise', `entered ${id}`, `not carried ${id}`]);
      expect(e.message).not.toMatch(/carried out on the chain/);
      expect(first.chain.adopted).toBe(true);
      const again = adoptionPress({ kept: first.kept.kept, adopted: true });
      await again.press();
      /* RED WHEN: the resume of a vault already adopted leaves its adoption open in the company's proposals. */
      expect(again.kept.log).toEqual([`entered ${id}`, `carried ${id}`]);
      expect(again.kept.kept[0]!.status).toBe('executed');
      expect(again.log.filter((l) => l.startsWith('sent '))).toEqual([]);
    });

    it('a limited seat sets up no vault and raises no proposal for one', async () => {
      const fresh = adoptionPress({ role: 'limited' });
      const e = await fresh.press(null);
      /* RED WHEN: a seat whose role may not raise a proposal deploys a vault it cannot start. */
      expect(e.message).toMatch(/your seat's role on this company may not raise proposals/);
      /* RED WHEN: a seat whose role may not raise is refused without a kind, so the page can only say it did not finish. */
      expect(e).toMatchObject({ name: 'VaultNotBuilt', code: 'seat-may-not-raise' });
      expect(fresh.log.filter((l) => l === 'sent deploy' || l.startsWith('build vault'))).toEqual([]);
      const resumed = adoptionPress({ role: 'limited' });
      const r = await resumed.press();
      /* RED WHEN: a limited seat's raise of an adoption is written down or sent. */
      expect(r.message).toMatch(/may not raise proposals/);
      expect(resumed.kept.log).toEqual([]);
      expect(resumed.log.filter((l) => l.startsWith('built'))).toEqual([]);
    });

    it('a seat this device does not believe sets up no vault and raises no proposal for one', async () => {
      for (const notBelieved of ['unattested', 'not-on-the-chain'] as const) {
        const fresh = adoptionPress({ notBelieved });
        const e = await fresh.press(null);
        /* RED WHEN: a seat every device would refuse the records of deploys a vault, or raises its adoption. */
        expect(e.message, notBelieved).toMatch(/your seat is not one this device believes/);
        expect(e, notBelieved).toMatchObject({ name: 'VaultNotBuilt', code: 'seat-not-believed' });
        expect(fresh.log.filter((l) => l === 'sent deploy' || l.startsWith('build vault')), notBelieved).toEqual([]);
        const resumed = adoptionPress({ notBelieved });
        expect((await resumed.press()).message, notBelieved).toMatch(/your seat is not one this device believes/);
        expect(resumed.kept.log, notBelieved).toEqual([]);
        expect(resumed.log.filter((l) => l.startsWith('built')), notBelieved).toEqual([]);
      }
    });

    it('a raise written down and not carried to the chain is sent again under the same record, never written twice', async () => {
      const first = adoptionPress({ failSend: true });
      const e = await first.press();
      expect(e.message).toMatch(/raising its adoption was not sent/);
      expect(first.kept.log).toEqual(['file and raise']);
      const again = adoptionPress({ kept: first.kept.kept });
      await again.press();
      /* RED WHEN: the next press writes a second record of the same proposal instead of sending the one there. */
      expect(again.kept.kept).toHaveLength(1);
      expect(again.kept.log).toEqual([`send ${first.kept.kept[0]!.id}`, `entered ${first.kept.kept[0]!.id}`, `carried ${first.kept.kept[0]!.id}`]);
      expect(again.chain.adopted).toBe(true);
    });

    it('a set-up raise past its deadline by the chain\'s time that never landed is withdrawn, then raised again under a new record, and lands', async () => {
      const old = adasAdoptionAt(new Date(Date.now() - 2 * DAY).toISOString());
      const t = adoptionPress({ kept: [old] });
      await t.press();
      const fresh = t.kept.kept[1];
      /* RED WHEN: the press sends the old record's raise again, which the chain refuses for good, so the vault can never be adopted. */
      expect(t.chain.adopted).toBe(true);
      expect(fresh).toMatchObject({ chainId: ADOPTION.proposal, digest: ADOPTION.payload, status: 'executed' });
      expect(Date.parse(fresh!.createdAt)).toBeGreaterThan(Date.parse(old.createdAt));
      /* RED WHEN: the new raise carries the old record's deadline, or another than its own record's. */
      expect(t.raisedBy).toEqual([raiseByOf(fresh!.createdAt)]);
      /* RED WHEN: the new record is written down while the old one is still open, so the company holds two proposals for one adoption. */
      expect(t.kept.log).toEqual([`withdrawn ${old.id}`, 'file and raise', `entered ${fresh!.id}`, `carried ${fresh!.id}`]);
      expect(t.kept.kept[0]!.status).toBe('cancelled');
      const again = adoptionPress({ kept: t.kept.kept, adopted: true });
      await again.press();
      /* RED WHEN: a later press takes the withdrawn record, under the same identity on the chain, for the adoption's record. */
      expect(again.kept.log).toEqual([`entered ${fresh!.id}`]);
    });

    it('a set-up raise still inside its deadline is sent again under its own record, never withdrawn or raised beside it', async () => {
      const old = adasAdoptionAt(new Date(Date.now() - DAY / 24).toISOString());
      const t = adoptionPress({ kept: [old], chainTime: Date.now() + DAY });
      await t.press();
      /* RED WHEN: a raise that may still land is withdrawn and a second one filed beside it; or judged by the chain's time alone, against this device's clock. */
      expect(t.kept.log).toEqual([`send ${old.id}`, `entered ${old.id}`, `carried ${old.id}`]);
      expect(t.kept.kept).toHaveLength(1);
      expect(t.raisedBy).toEqual([raiseByOf(old.createdAt)]);
      expect(t.chain.adopted).toBe(true);
    });

    it('a set-up raise past its deadline by this device\'s clock alone is neither withdrawn nor raised again', async () => {
      const old = adasAdoptionAt(new Date(Date.now() - 2 * DAY).toISOString());
      const behind = adoptionPress({ kept: [old], chainTime: Date.now() - 2 * DAY + DAY / 2 });
      const e = await behind.press();
      /* RED WHEN: a raise the chain may still take, by its own time, is judged dead by this device's clock. */
      expect(e.message).toMatch(new RegExp(`may still reach the chain until ${new Date(Number(raiseByOf(old.createdAt)) * 1000).toISOString()}`, 'u'));
      expect(behind.kept.log).toEqual([]);
      expect(behind.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
      const unread = adoptionPress({ kept: [old], chainTime: null });
      const u = await unread.press();
      /* RED WHEN: a page that cannot read the chain's time withdraws the record on this device's clock. */
      expect(u.message).toMatch(/cannot read the chain's time/u);
      expect(unread.kept.log).toEqual([]);
      expect(unread.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
    });

    it('one millisecond before its deadline by the chain\'s time a set-up raise may still land, and at its deadline it can no longer', async () => {
      const old = adasAdoptionAt(new Date(Date.now() - 2 * DAY).toISOString());
      const byMs = Number(raiseByOf(old.createdAt)) * 1000;
      const before = adoptionPress({ kept: [old], chainTime: byMs - 1 });
      const e = await before.press();
      /* RED WHEN: a raise is taken for dead while a block before its deadline can still carry it. */
      expect(e.message).toMatch(/may still reach the chain until/u);
      expect(before.kept.log).toEqual([]);
      expect(before.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
      const at = adoptionPress({ kept: [old], chainTime: byMs });
      await at.press();
      /* RED WHEN: a raise is still waited for once the chain's time has reached its deadline, when no block can carry it. */
      expect(at.kept.log[0]).toBe(`withdrawn ${old.id}`);
      expect(at.chain.adopted).toBe(true);
    });

    it('a set-up raise the chain shows only once its time is read is neither withdrawn nor raised again', async () => {
      const old = adasAdoptionAt(new Date(Date.now() - 2 * DAY).toISOString());
      const t = adoptionPress({ kept: [old], onTimeRead: (chain) => { chain.open = true; chain.approvals = 1; } });
      const e = await t.press();
      /* RED WHEN: whether the chain holds the raise is judged only from a read made before its time, so one that landed between the two is withdrawn. */
      expect(e.message).toMatch(new RegExp(`the chain now shows the vault's adoption written down as ${old.id} raised`, 'u'));
      expect(t.kept.log).toEqual([]);
      expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
    });

    it('a raise relayed and not entered is entered on the next press, once the chain holds it, without being sent again', async () => {
      const first = adoptionPress({ failEnter: 1 });
      await first.press();
      const id = first.kept.kept[0]!.id;
      /* RED WHEN: a record written down and raised whose entry is refused stops the vault's start. */
      expect(first.kept.log).toEqual(['file and raise', `not entered ${id}`, `carried ${id}`]);
      expect(first.chain.adopted).toBe(true);
      const again = adoptionPress({ kept: first.kept.kept, adopted: true });
      await again.press();
      /* RED WHEN: the record is looked for only while the chain does not hold the proposal yet. */
      expect(again.kept.log).toEqual([`entered ${id}`]);
      expect(again.log.filter((l) => l.startsWith('built'))).toEqual([]);
    });

    it('a raise written down by a seat this device does not believe filed it is not sent under that record: its deadline is not the service\'s to set', async () => {
      const theirs = proposalsKeptInATest({ signingSecret: '55'.repeat(32) as Hex });
      const sealedBy = await theirs.doors.service.file('acc_1', {
        proposal: signProposalFiling('acc_1', {
          id: 'prp_aaaaaaaaaaaa', digest: ADOPTION.payload as Hex, chainId: ADOPTION.proposal as Hex, keyEpoch: 0, createdAt: new Date(0).toISOString(),
          sealed: sealGovernanceProposal({ accountId: 'acc_1', viewingKey: VIEWING as Hex, kind: 'adopt-vault', summary: 'Add a new vault to the company',
            noVault: ADOPTION.named as Hex, body: { vault: VAULT as Hex }, change: { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: ADOPTION.salt as Hex }, proposedBy: 'bo' }),
        }, '55'.repeat(32) as Hex),
        salt: ADOPTION.salt,
      });
      const t = adoptionPress({ kept: theirs.kept });
      const e = await t.press();
      /*
       * RED WHEN: a raise is sent under a record no seat of the company is believed to have filed: its createdAt, which
       * sets the raise's deadline, would then be whatever the service chose.
       */
      expect(e.message).toMatch(new RegExp(`hold a record, ${sealedBy.id}, under the identity of the vault's adoption that no seat of the company is believed to have written down`, 'u'));
      expect(e.message).toMatch(/Ask the signer who wrote it down to open the company so their device enters it, then press again/u);
      expect(t.kept.log).toEqual([]);
      expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
      expect(t.kept.kept).toHaveLength(1);
    });

    /* A record of the adoption as Ada's seat signs it, over `digest`, or with the signature of another record. */
    const ownRecord = (over: { digest?: string; signatureOf?: string } = {}): SealedProposal => {
      const sign = (id: string, digest: string) => signProposalFiling('acc_1', {
        id, digest: digest as Hex, chainId: ADOPTION.proposal as Hex, keyEpoch: 0, createdAt: new Date(0).toISOString(),
        sealed: sealGovernanceProposal({ accountId: 'acc_1', viewingKey: VIEWING as Hex, kind: 'adopt-vault', summary: 'Add a new vault to the company',
          noVault: ADOPTION.named as Hex, body: { vault: VAULT as Hex }, change: { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: ADOPTION.salt as Hex }, proposedBy: 'ada' }),
      }, '11'.repeat(32) as Hex);
      const f = sign('prp_forgedAAAAAA', over.digest ?? ADOPTION.payload);
      const signature = over.signatureOf === undefined ? f.filedBy.signature : sign('prp_otherAAAAAAA', over.signatureOf).filedBy.signature;
      return { ...f, filedBy: { ...f.filedBy, signature }, accountId: 'acc_1', status: 'open', approvalCount: 0 };
    };

    it('a record under a setup proposal\'s identity that the company could not have written down is neither entered nor raised under', async () => {
      for (const [why, forged] of [
        ['its signature is not over it', ownRecord({ signatureOf: 'c4'.repeat(32) })],
        ['it is over another payload', ownRecord({ digest: 'c5'.repeat(32) })],
      ] as const) {
        for (const open of [false, true]) {
          const t = adoptionPress({ kept: [forged], open });
          const e = await t.press();
          /* RED WHEN: a record carrying this device's key, and not one it could have filed for this proposal, is entered or raised under. */
          expect(e.message, why).toMatch(/hold a record, prp_forgedAAAAAA, under the identity of the vault's adoption that is not a record of it/);
          expect(t.kept.log, why).toEqual([]);
          expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent ')), why).toEqual([]);
        }
      }
    });

    it('a setup proposal the chain holds that a press cannot leave written down is said, and the start carries on', async () => {
      const refused = adoptionPress({ open: true, needed: 2 });
      refused.kept.doors.service.file = async () => { throw new Error('a proposal open for the same change is already written down'); };
      await refused.press();
      /* RED WHEN: a setup proposal the chain holds stays unrecorded and the press says nothing of it. */
      expect(refused.came()?.state).toBe('awaiting-approvals');
      expect(refused.came()?.said).toEqual([expect.stringMatching(
        /^The vault's adoption is on the chain and is not written down in the company's records yet: a proposal open for the same change is already written down\./)]);
      /* RED WHEN: a proposal left unwritten is said only as an English sentence, with no kind the page can word. */
      expect(refused.came()?.saidCodes).toEqual(['proposal-not-written-down']);
      expect(refused.log.filter((l) => l.startsWith('sent '))).toEqual(['sent approve']);
      const theirs = proposalsKeptInATest({ signingSecret: '55'.repeat(32) as Hex });
      await theirs.doors.service.file('acc_1', {
        proposal: signProposalFiling('acc_1', {
          id: 'prp_bbbbbbbbbbbb', digest: ADOPTION.payload as Hex, chainId: ADOPTION.proposal as Hex, keyEpoch: 0, createdAt: new Date(0).toISOString(),
          sealed: ownRecord().sealed,
        }, '55'.repeat(32) as Hex),
        salt: ADOPTION.salt,
      });
      const carried = adoptionPress({ open: true, needed: 2, kept: theirs.kept });
      await carried.press();
      /* RED WHEN: another seat's record no device believes yet is left as it is and nothing is said. */
      expect(carried.came()?.said).toEqual([expect.stringMatching(/written down by another signer, and is believed once that signer's device enters it/)]);
      expect(carried.came()?.saidCodes).toEqual(['proposal-not-written-down']);
      const written = adoptionPress({ open: true, needed: 2 });
      await written.press();
      expect(written.came()?.said).toBeUndefined();
      /* RED WHEN: a press that left nothing unwritten carries a kind for something it did not say. */
      expect(written.came()?.saidCodes).toBeUndefined();
    });

    it('approving and adopting read no proposal record, so a service that withholds them stops no step after the raise', async () => {
      const t = adoptionPress({ open: true });
      t.kept.doors.service.sealedProposals = async () => { throw new Error('the service withheld the company\'s proposals'); };
      await t.press();
      /* RED WHEN: the start stops because the company's proposals could not be read, where it needs nothing from them. A round raised by another seat, so the chain holds no approval of this one's. */
      expect(t.log.filter((l) => l.startsWith('sent '))).toEqual(['sent approve', 'sent adopt']);
      expect(t.chain.adopted).toBe(true);
    });

    /*
     * A chain that holds what reaches it for the first secret: the run opens when its raise is built, counted at once
     * as the raiser's own approval unless `counted` is false (a chain built before that), and the secret is set when
     * the secret transaction is sent. The run's standing says whether the chain holds this seat's approval.
     */
    const secretPress = async (over: { counted?: boolean; needed?: number; straight?: true; records?: SealedProposal[]; onTimeRead?: (chain: { run: boolean; approvals: number; window: { opensAt: string; closesAt: string } | null }) => void } = {}) => {
      const log: string[] = [];
      const chain = { run: false, approvals: 0, set: false, mine: false, copied: false, window: null as { opensAt: string; closesAt: string } | null };
      const raisedBy: string[] = [];
      const kept = proposalsKeptInATest({ signingSecret: '11'.repeat(32) as Hex, ...(over.records === undefined ? {} : { kept: over.records }) });
      const a = { ...ada([walletRead(committeeKey)], log), proposals: kept.doors };
      const base = chainBuilder(log, {})();
      const b: VaultBuilderClient = {
        ...base,
        governedCall: async (i) => {
          log.push(`built ${i.order.circuit}`);
          if (i.order.circuit === 'propose') {
            raiseOrRefuse(i.opened.raiseBy, raisedBy);
            const w = (i.order as { run?: { opensAt: unknown; closesAt: unknown } }).run;
            chain.window = over.records === undefined || w === undefined ? null : { opensAt: String(w.opensAt), closesAt: String(w.closesAt) };
            chain.run = true; chain.approvals = over.counted === false ? 0 : 1; chain.mine = over.counted !== false;
          }
          return { tx: `T-${i.order.circuit}` };
        },
        startStanding: async (i) => {
          const s = await base.startStanding(i);
          const sec = s.standing.secret;
          if (sec === undefined) return s;
          /* Given records, the run's identity is made from its window, as the account's circuits make it. */
          const raise = over.records === undefined || i.window === undefined ? {}
            : { raise: { ...runOver(i.window), named: 'b9'.repeat(32), salt: 'ba'.repeat(32), opensAt: i.window.opensAt, closesAt: i.window.closesAt } };
          return { ...s, standing: { ...s.standing, secret: { ...sec, ...raise, set: chain.set, written: [chain.copied], started: chain.copied, run: chain.run ? {
            proposal: 'b7'.repeat(32), payload: 'b8'.repeat(32), named: 'b9'.repeat(32), salt: 'ba'.repeat(32),
            open: true, approvals: chain.approvals, needed: over.needed ?? 1, stale: false, opensAt: '1', closesAt: '2', inWindow: true,
            beforeARemoval: false,
            ...(chain.window === null ? {} : { ...runOver(chain.window), ...chain.window }),
            ...(i.seat === undefined ? {} : { approvedHere: chain.mine }),
          } : null } } };
        },
        setNonceSecret: async () => { log.push('built set'); return { tx: 'S' }; },
        writeSecretCopy: async () => ({ tx: 'C' }),
      };
      const service = serviceFrom([heldByThem], log, {
        keys: async () => ({ committee, why: null, readers: [a.mine] }),
        startAccountCall: async (_v, body) => {
          log.push(`sent ${body.call}`);
          if (body.call === 'approve') { chain.approvals += 1; chain.mine = true; }
          return { txRef: 't' };
        },
        startSecret: async () => { log.push('sent secret'); chain.set = true; return { txRef: 't' }; },
        startCopy: async () => { log.push('sent copy'); chain.copied = true; return { txRef: 't' }; },
      });
      /* The person's own wallet, sending each call straight to the chain: the chain takes it as it takes one relayed. */
      const handOver = over.straight === undefined ? {} : {
        handOver: {
          path: 'chain' as const,
          toChain: async (_tx: string, call: { kind: string; circuit: string; contract: string }) => {
            log.push(`to the chain ${call.kind} ${call.circuit} on ${call.contract}`);
            if (call.kind === 'vault-secret') chain.set = true;
            if (call.kind === 'vault-copy') chain.copied = true;
            if (call.circuit === 'approve') { chain.approvals += 1; chain.mine = true; }
          },
        },
      };
      let came: VaultCreated | undefined;
      await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder: b, ...handOver, chainTime: async () => { over.onTimeRead?.(chain); return Date.now(); } }, VAULT)
        .then((r) => { came = r; }, () => undefined);
      return { log, kept, raisedBy, sent: log.filter((l) => l.startsWith('sent ') && l !== 'sent copy'), came: () => came };
    };
    /* A first secret run's identity and payload over its window: another window, another identity. */
    const runOver = (w: { readonly opensAt: string; readonly closesAt: string }) => ({
      proposal: createHash('sha256').update(`run ${w.opensAt} ${w.closesAt}`).digest('hex'),
      payload: createHash('sha256').update(`payload ${w.opensAt} ${w.closesAt}`).digest('hex'),
    });
    /* Ada's record of the first secret run over the window opened ten minutes before `createdAt`, written down and sent then. */
    const runWindowAt = (createdAt: string) => {
      const at = BigInt(Math.floor(Date.parse(createdAt) / 1000));
      return { opensAt: String(at - 600n), closesAt: String(at + 14n * 86_400n) };
    };
    const adasRunAt = (createdAt: string, id = 'prp_runWrittenAa'): SealedProposal => {
      const w = runWindowAt(createdAt);
      const r = runOver(w);
      const f = signProposalFiling('acc_1', {
        id, digest: r.payload as Hex, chainId: r.proposal as Hex, keyEpoch: 0, createdAt,
        sealed: sealVaultSecretProposal({ accountId: 'acc_1', viewingKey: VIEWING as Hex, summary: 'Finish setting up a new vault',
          run: { vault: VAULT as Hex, root: 'b5'.repeat(32) as Hex, payees: '1', ...w },
          change: { asset: 'b6'.repeat(32), amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: 'ba'.repeat(32) as Hex }, proposedBy: 'ada' }),
      }, '11'.repeat(32) as Hex);
      return { ...f, accountId: 'acc_1', status: 'open', approvalCount: 0, txRef: 'T-earlier' };
    };
    const runsOf = (t: { kept: { kept: SealedProposal[] } }) => t.kept.kept.filter((r) => r.chainId !== ADOPTION.proposal);

    /*
     * Two runs of one first secret open at once: one raised before a signer was removed, the other raised again after it
     * by this device's earlier press, landed and written down. The chain's run windows list them in `order`; the read the
     * account's circuits answer reports the run under the window it was asked about (`runFor`, the standing's own rule).
     */
    const twoRunsPress = async (order: 'before-first' | 'after-first') => {
      const log: string[] = [];
      const createdAt = new Date(Date.now() - DAY / 24).toISOString();
      const w1 = { opensAt: '10', closesAt: String(Math.floor(Date.now() / 1000) + 86_400) };
      const w2 = runWindowAt(createdAt);
      const r1 = runOver(w1).proposal;
      const r2 = runOver(w2).proposal;
      const kept = proposalsKeptInATest({ signingSecret: '11'.repeat(32) as Hex, kept: [{ ...adasRunAt(createdAt), raisedAt: createdAt }] });
      const a = { ...ada([walletRead(committeeKey)], log), proposals: kept.doors };
      const base = chainBuilder(log, {})();
      const approvals: Record<string, number> = { [r1]: 1, [r2]: 1 };
      let set = false;
      let copied = false;
      const runOf = (w: { opensAt: string; closesAt: string }, before: boolean, seat: boolean) => ({
        ...runOver(w), named: 'b9'.repeat(32), salt: 'ba'.repeat(32), open: true, approvals: approvals[runOver(w).proposal]!, needed: 2, stale: false,
        ...w, inWindow: true, beforeARemoval: before, ...(seat ? { approvedHere: approvals[runOver(w).proposal]! > 1 } : {}),
      });
      const b: VaultBuilderClient = {
        ...base,
        governedCall: async (i) => {
          log.push(`built ${i.order.circuit} ${String((i.order as { proposal?: unknown }).proposal ?? '')}`);
          if (i.order.circuit === 'approve') approvals[String((i.order as { proposal: unknown }).proposal)]! += 1;
          return { tx: `T-${i.order.circuit}` };
        },
        startStanding: async (i) => {
          const s = await base.startStanding(i);
          const sec = s.standing.secret;
          if (sec === undefined) return s;
          const runs = order === 'before-first'
            ? [runOf(w1, true, i.seat !== undefined), runOf(w2, false, i.seat !== undefined)]
            : [runOf(w2, false, i.seat !== undefined), runOf(w1, true, i.seat !== undefined)];
          const raise = i.window === undefined ? {} : { raise: { ...runOver(i.window), named: 'b9'.repeat(32), salt: 'ba'.repeat(32), opensAt: i.window.opensAt, closesAt: i.window.closesAt } };
          return { ...s, standing: { ...s.standing, secret: { ...sec, ...raise, set, written: [copied], started: copied, landed: runs.map((r) => r.proposal),
            run: set ? null : runFor(runs, i.window === undefined ? undefined : runOver(i.window).proposal as Hex) } } };
        },
        setNonceSecret: async (i) => { log.push(`built set ${i.proposal}`); return { tx: 'S' }; },
        writeSecretCopy: async () => ({ tx: 'C' }),
      };
      const service = serviceFrom([heldByThem], log, {
        keys: async () => ({ committee, why: null, readers: [a.mine] }),
        startAccountCall: async () => ({ txRef: 't' }),
        startSecret: async () => { set = true; return { txRef: 't' }; },
        startCopy: async () => { copied = true; return { txRef: 't' }; },
      });
      await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder: b, chainTime: async () => Date.now() }, VAULT)
        .catch(() => undefined);
      return { log: log.filter((l) => l.startsWith('built ')), r1, r2 };
    };

    it('with a run raised before a removal open beside the one raised after it, in either ledger order, the later is approved and set and nothing else', async () => {
      for (const order of ['before-first', 'after-first'] as const) {
        const t = await twoRunsPress(order);
        /* RED WHEN: the run the ledger lists first is read, so the one raised before the removal is approved or set (V12), or yet another is raised (V11). */
        expect(t.log, order).toEqual([`built approve ${t.r2}`, `built set ${t.r2}`]);
      }
    });

    it('a first secret run still inside its deadline is sent again under its own record, and no second run is raised beside it', async () => {
      const old = adasRunAt(new Date(Date.now() - DAY / 24).toISOString());
      const t = await secretPress({ records: [old] });
      /* RED WHEN: a press raises a run over a new window while the one written down before may still land, so two runs set up one vault. */
      expect(runsOf(t).map((r) => r.id)).toEqual([old.id]);
      expect(t.kept.log.filter((l) => l.startsWith('file and raise') || l.startsWith('send ') || l.startsWith('withdrawn'))).toEqual([`send ${old.id}`]);
      expect(t.raisedBy).toEqual([raiseByOf(old.createdAt)]);
      expect(t.sent).toEqual(['sent secret']);
      expect(runsOf(t)[0]!.status).toBe('executed');
    });

    it('a first secret run the chain shows only once its time is read is not withdrawn, and no second run is raised beside it', async () => {
      const createdAt = new Date(Date.now() - 2 * DAY).toISOString();
      const old = adasRunAt(createdAt);
      const t = await secretPress({ records: [old], onTimeRead: (chain) => { chain.run = true; chain.approvals = 1; chain.window = runWindowAt(createdAt); } });
      /* RED WHEN: a run that landed between the start's read of the chain and its read of the chain's time is withdrawn and a second run raised beside it. */
      expect(runsOf(t).map((r) => [r.id, r.status])).toEqual([[old.id, 'open']]);
      expect(t.kept.log.filter((l) => l.startsWith('withdrawn') || l.startsWith('file and raise') || l.startsWith('send '))).toEqual([]);
      expect(t.log).not.toContain('built propose');
    });

    it('a first secret run past its deadline by the chain\'s time that never landed is passed over, never withdrawn, and a new one is raised and counted', async () => {
      const old = adasRunAt(new Date(Date.now() - 2 * DAY).toISOString());
      const t = await secretPress({ records: [old] });
      const fresh = runsOf(t).find((r) => r.id !== old.id);
      /* RED WHEN: a dead run's record is withdrawn, which only its filer can do, so a record left by a signer who has gone would hold the vault's secret up. */
      expect(t.kept.log.filter((l) => l.startsWith('withdrawn'))).toEqual([]);
      expect(t.raisedBy).toEqual([raiseByOf(fresh!.createdAt)]);
      /* Left open while the new run is raised, it is closed with it once the vault holds the secret both name. */
      expect(runsOf(t).map((r) => [r.id, r.status])).toEqual([[old.id, 'executed'], [fresh!.id, 'executed']]);
      /* RED WHEN: the dead record is sent again or entered as though it were a proposal still standing. */
      expect(t.kept.log.filter((l) => l.endsWith(old.id) && !l.startsWith('carried'))).toEqual([]);
      expect(t.sent).toEqual(['sent secret']);
    });

    it('sent straight to the chain, the raise, the approval, the secret and its sealed copy go from the person\'s wallet and the service relays none', async () => {
      const t = await secretPress({ counted: false, straight: true });
      /* RED WHEN: on the chain path the service still relays a step of the vault's start, so it is sent twice. */
      expect(t.log.filter((l) => l.startsWith('sent '))).toEqual([]);
      expect(t.kept.log.filter((l) => l.startsWith('file'))).not.toContain('file and raise');
      /* RED WHEN: the secret is sent as anything but the vault's own call checked as the service checks it, or the copy is not sent. */
      expect(t.log.filter((l) => l.startsWith('to the chain'))).toEqual([
        `to the chain account-call propose on ${ACCOUNT}`, `to the chain account-call approve on ${ACCOUNT}`,
        `to the chain vault-secret setNonceSecret on ${VAULT}`, `to the chain vault-copy writeSecretCopy on ${VAULT}`,
      ]);
    });

    /* RED WHEN: the raiser of the first secret run sends an approval of its own after a raise the chain counted as one, which the chain refuses. */
    it('a first secret run whose raise the chain counted goes straight to setting the secret, with no approval of its own', async () => {
      const t = await secretPress();
      expect(t.sent).toEqual(['sent secret']);
      expect(t.log).toContain('built propose');
      expect(t.log).toContain('built set');
      expect(t.log).not.toContain('built approve');
    });

    it('a first secret run the start carried out is written down as carried out once the chain shows the vault started', async () => {
      const t = await secretPress();
      const rec = t.kept.kept.find((r) => r.chainId === 'b7'.repeat(32));
      /* RED WHEN: a vault's first secret run stays open in the company's records after its secret is set. */
      expect(rec?.status).toBe('executed');
      expect(t.kept.log.filter((l) => l.startsWith('carried'))).toEqual([`carried ${t.kept.kept[0]!.id}`, `carried ${rec!.id}`]);
    });

    /* RED WHEN: a first secret run on a chain that did not count the raise is carried out with no approval, or its approval is not sent first. */
    it('a first secret run raised on a chain that did not count the raise is approved by this seat before the secret is set', async () => {
      const t = await secretPress({ counted: false });
      expect(t.sent).toEqual(['sent approve', 'sent secret']);
    });

    /* RED WHEN: with two approvals needed the raiser builds or sends a second approval, though the chain holds its raise as its approval, or sets the secret on one. */
    it('with two approvals needed, a counted first secret raise builds no approval and waits for the other', async () => {
      const t = await secretPress({ needed: 2 });
      expect(t.sent).toEqual([]);
      expect(t.log).not.toContain('built approve');
      expect(t.log).not.toContain('built set');
      expect(t.came()).toMatchObject({ state: 'awaiting-approvals', awaiting: { round: 'first-secret', approvals: 1, needed: 2 } });
    });

    it('a vault\'s first secret run is written down with each reader\'s own sealed copy, and without the secret it sets', async () => {
      const log: string[] = [];
      const kept = proposalsKeptInATest({ signingSecret: '11'.repeat(32) as Hex });
      const a = { ...ada([walletRead(committeeKey)], log), proposals: kept.doors };
      const service = serviceFrom([heldByThem], log, { keys: async () => ({ committee, why: null, readers: [a.mine] }) });
      const base = chainBuilder(log, {})();
      /* The run as the device makes it: its nonce, details and commitment beside the copies; only the copies go in the record. */
      const MADE = { nonce: 'c1'.repeat(32), details: 'c2'.repeat(32), commitment: 'c3'.repeat(32) };
      const b: VaultBuilderClient = {
        ...base,
        governedCall: async (i) => { log.push(`built ${i.order.circuit}`); return { tx: `T-${i.order.circuit}` }; },
        startStanding: async (i) => {
          const s = await base.startStanding(i);
          return s.run === undefined ? s : { ...s, run: { ...s.run, ...MADE } };
        },
      };
      await createCompanyVault({ ...pacing, ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder: b }, VAULT)
        .catch((x) => x);
      const secret = (await newest(a)).secret;
      /* The adoption the chain already holds is written down first; then the run, with its raise. */
      expect(kept.log.filter((l) => l.startsWith('file'))).toEqual(['file', 'file and raise']);
      const rec = kept.kept[1]!;
      expect(rec).toMatchObject({ chainId: 'b7'.repeat(32), digest: 'b8'.repeat(32) });
      /* The run's identity names the vault it is for, which the service holds to the signed identity. */
      expect(kept.bodies[1]).toMatchObject({ salt: 'ba'.repeat(32), vault: 'b9'.repeat(32) });
      const { envelope, body } = opened(rec);
      /* RED WHEN: the record is sealed with the secret or what the run was made of, which every reader of the company's proposals opens. */
      const everything = JSON.stringify({ envelope, body }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      expect(everything).not.toContain(secret.slice(0, 16));
      for (const made of Object.values(MADE)) expect(everything).not.toContain(made);
      /* RED WHEN: the record leaves out what its identity on the chain is made from, or a reader's sealed copy, so no other device can approve or set it. */
      expect(envelope).toMatchObject({ kind: 'vault-secret', vault: VAULT });
      expect(body).toEqual({ vault: VAULT, root: 'b5'.repeat(32), payees: '1', opensAt: '1', closesAt: '2',
        copies: [{ reader: a.mine, parts: sealed(secret, a.mine) }],
        __change: { asset: 'b6'.repeat(32), amount: 0n, batchDigest: '00'.repeat(32), salt: 'ba'.repeat(32) } });
      /* The copy in the record opens only with its reader's own key, to the secret the run sets. */
      expect(openSecretCopy({ vault: VAULT as Hex, parts: (body.copies as { parts: string[] }[])[0]!.parts.map((p) => fromHex(p)), reader: recordsKeypairFrom(a.me.companyKey) })).toBe(secret);
    });

    it('a first secret run the chain holds with no record behind it is written down on the next press, and not raised again', async () => {
      const log: string[] = [];
      const kept = proposalsKeptInATest({ signingSecret: '11'.repeat(32) as Hex });
      const a = { ...ada([walletRead(committeeKey)], log), proposals: kept.doors };
      const raised = startNonceSecret(VAULT, [{ publicKey: a.mine }]);
      await a.records('nonce-secret').put(VAULT, raised);
      const S = openNonceSecrets(raised, VAULT, recordsKeypairFrom(a.me.companyKey)).secrets[0]!;
      await press(a, log, { openRunFor: S });
      /* RED WHEN: a first secret run is written down only when this device raises it, so one the chain holds stays unrecorded. */
      expect(kept.kept.map((r) => r.chainId)).toEqual(['a1'.repeat(32), 'b1'.repeat(32)]);
      expect(kept.bodies[1]).toMatchObject({ salt: 'b4'.repeat(32), vault: 'b3'.repeat(32) });
      expect(kept.log).toEqual(['file', `entered ${kept.kept[0]!.id}`, `carried ${kept.kept[0]!.id}`, 'file', `entered ${kept.kept[1]!.id}`]);
      expect(log).not.toContain('built propose');
    });
  });

  describe('EACH PROPOSAL OF A NEW VAULT\'S START IS APPROVED AND CARRIED OUT BY ANOTHER SIGNER, WITH THE START\'S OWN CHECKS', () => {
    const VIEWING = '44'.repeat(32) as Hex;
    /* Bo raised both rounds on his own device; this device is Ada's, approving them. */
    const BOS = '55'.repeat(32) as Hex;
    const ADOPTION = { proposal: 'a1'.repeat(32), payload: 'a2'.repeat(32), named: 'a3'.repeat(32), salt: 'a4'.repeat(32) };
    const RUN = { proposal: 'b7'.repeat(32), payload: 'b8'.repeat(32), named: 'b9'.repeat(32), salt: 'ba'.repeat(32) };
    const filed = (id: string, chainId: string, digest: string, sealed: Sealed): SealedProposal => {
      const f = signProposalFiling('acc_1', { id, digest: digest as Hex, chainId: chainId as Hex, keyEpoch: 0, createdAt: '2026-11-01T00:00:00.000Z', sealed }, BOS);
      return { id, accountId: 'acc_1', status: 'open', createdAt: f.createdAt, digest: f.digest, chainId: f.chainId, approvalCount: 1, keyEpoch: 0, sealed: f.sealed, filedBy: f.filedBy, raisedAt: f.createdAt };
    };
    const adoptionRecord = (vault = VAULT) => filed('prp_adoptionOfAb', ADOPTION.proposal, ADOPTION.payload, sealGovernanceProposal({
      accountId: 'acc_1', viewingKey: VIEWING, kind: 'adopt-vault', summary: 'Add a new vault to the company', noVault: ADOPTION.named as Hex,
      body: { vault }, change: { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: ADOPTION.salt as Hex }, proposedBy: 'bo',
    }));
    const secretRecord = (window = { opensAt: '1', closesAt: '2' }, chainId = RUN.proposal, id = 'prp_firstSecretB') => filed(id, chainId, RUN.payload, sealVaultSecretProposal({
      accountId: 'acc_1', viewingKey: VIEWING, summary: 'Finish setting up a new vault',
      run: { vault: VAULT as Hex, root: 'b5'.repeat(32) as Hex, payees: '1', ...window },
      change: { asset: 'b6'.repeat(32), amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: RUN.salt as Hex }, proposedBy: 'bo',
    }));
    /*
     * The chain both rounds stand on, as this device reads it: each open, counted at the raiser's one approval, at a bar
     * of `needed`; an approval sent adds one, an adoption or a secret sent carries it out, a copy sent writes it.
     */
    const start = async (over: { needed?: number; mine?: boolean; stale?: boolean; adopted?: boolean; set?: boolean; inWindow?: boolean; records?: SealedProposal[]; approvers?: Parameters<typeof createCompanyVault>[0]['approvers']; refuse?: string; copyFails?: number; beforeARemoval?: boolean; earlier?: { secret: string } | { unheld: true } | null; held?: string; noRun?: boolean } = {}) => {
      const log: string[] = [];
      const chain = { approvals: 1, mine: over.mine ?? false, adopted: over.adopted ?? false, set: over.set ?? false, copied: false, adoptionOpen: !(over.adopted ?? false) };
      const kept = proposalsKeptInATest({ signingSecret: '11'.repeat(32) as Hex, kept: over.records ?? [adoptionRecord(), secretRecord()] });
      const a = ada([walletRead(committeeKey)], log);
      await a.records('nonce-secret').put(VAULT, startNonceSecret(VAULT, [{ publicKey: a.mine }]));
      const carried: Array<{ id: string; body: unknown }> = [];
      const proposals = { ...kept.doors, carried: async (id: string, body: Parameters<NonNullable<typeof kept.doors.carried>>[1]) => {
        carried.push({ id, body });
        if (id === over.refuse) throw new Error('the service\'s read of the chain still shows this first secret run open');
        return kept.doors.carried!(id, body);
      } };
      let copyFails = over.copyFails ?? 0;
      const asked: Array<{ previous?: string; earlier?: readonly string[] }> = [];
      const setWith: Array<string | undefined> = [];
      const raised: Array<{ proposal: string; opensAt: string; closesAt: string }> = [];
      const t0 = { raised };
      const b: VaultBuilderClient = {
        ...builder(log),
        governedCall: async (i) => {
          log.push(`built ${i.order.circuit}`);
          const w = (i.order as { run?: { opensAt: unknown; closesAt: unknown }; proposal?: unknown });
          if (i.order.circuit === 'propose' && w.run !== undefined) raised.push({ proposal: String(w.proposal), opensAt: String(w.run.opensAt), closesAt: String(w.run.closesAt) });
          return { tx: `T-${i.order.circuit}` };
        },
        setNonceSecret: async (i) => { log.push('built set'); setWith.push(i.earlier); return { tx: 'S' }; },
        writeSecretCopy: async () => { log.push('built copy'); return { tx: 'C' }; },
        startStanding: async (i) => {
          const mine = (i.readers ?? [])[0] ?? '';
          if (i.secret !== undefined) asked.push({ ...(i.previous === undefined ? {} : { previous: i.previous }), ...(i.earlier === undefined ? {} : { earlier: i.earlier }) });
          return {
            standing: {
              adopted: chain.adopted, removals: 0,
              adoption: { ...ADOPTION, open: chain.adoptionOpen, approvals: chain.approvals, needed: over.needed ?? 2, stale: over.stale === true, approvedHere: chain.mine },
              ...(i.secret === undefined ? {} : {
                secret: {
                  set: chain.set, another: false, rootIsThisRuns: true, written: [chain.copied], started: chain.copied, held: over.held ?? '00'.repeat(32), landed: [RUN.proposal, ...raised.map((r) => r.proposal)],
                  ...(over.earlier === undefined ? {} : { earlier: over.earlier }),
                  run: chain.set || (over.noRun === true && t0.raised.length === 0) ? null : { ...RUN, open: true, approvals: chain.approvals, needed: over.needed ?? 2, stale: false, approvedHere: chain.mine, opensAt: '1', closesAt: '2', inWindow: over.inWindow ?? true, beforeARemoval: over.beforeARemoval ?? false },
                  ...(i.window === undefined ? {} : {
                    raise: { ...RUN, proposal: i.window.opensAt === '1' && i.window.closesAt === '2' ? RUN.proposal : 'ee'.repeat(32), opensAt: i.window.opensAt, closesAt: i.window.closesAt },
                  }),
                },
              }),
            },
            ...(i.secret === undefined ? {} : {
              run: { root: 'b5'.repeat(32), payees: '1', asset: 'b6'.repeat(32), salt: RUN.salt, nonce: 'bb'.repeat(32), copiesRoot: 'bc'.repeat(32), count: '1', previous: i.previous ?? '00'.repeat(32), copies: [{ reader: mine, parts: sealed(i.secret, mine), path: [] }] } as never,
            }),
          };
        },
      };
      const service = serviceFrom([heldByThem], log, {
        keys: async () => ({ committee, why: null, readers: [a.mine] }),
        startAccountCall: async (_v, body) => {
          log.push(`sent ${body.step} ${body.call}`);
          if (body.call === 'approve') { chain.approvals += 1; chain.mine = true; }
          if (body.call === 'adopt') { chain.adopted = true; chain.adoptionOpen = false; }
          return { txRef: 't' };
        },
        startSecret: async () => { log.push('sent secret'); chain.set = true; return { txRef: 't' }; },
        startCopy: async () => {
          if (copyFails > 0) { copyFails -= 1; throw Object.assign(new Error('the page was closed'), { nothingWasSent: true }); }
          log.push('sent copy'); chain.copied = true; return { txRef: 't' };
        },
      });
      const doors = {
        ...pacing, ...walletReadsTheVault, ...a, account: ACCOUNT, service, builder: b, proposals,
        ...(over.approvers === undefined ? {} : { approvers: over.approvers }),
      };
      const filedBefore = (await a.records('nonce-secret').versions(VAULT)).length;
      /* What this device filed in the vault's records since the start of the test: approving and carrying out file nothing. */
      const filedSince = async () => [(await a.records('nonce-secret').versions(VAULT)).length - filedBefore, await a.records('pool').get(VAULT)];
      return { doors, log, chain, kept, carried, filedSince, asked, setWith, raised, a, sent: () => log.filter((l) => l.startsWith('sent ')) };
    };
    const ADOPT = { vault: VAULT as Hex, round: 'adoption' as const, proposal: 'prp_adoptionOfAb' };
    const SECRET = { vault: VAULT as Hex, round: 'first-secret' as const, proposal: 'prp_firstSecretB' };

    it('another signer approves the adoption, and carries it out once the chain counts its bar, writing it down and filing nothing', async () => {
      const t = await start();
      /* RED WHEN: a second signer cannot approve a vault's adoption outside the vault's own setup. */
      expect(await approveStartRoundHere(t.doors, ADOPT)).toBe('approved');
      expect(t.sent()).toEqual(['sent adoption approve']);
      /* RED WHEN: the adoption is carried out with no step of its own reading the chain's count first. */
      expect(await carryStartRoundHere(t.doors, ADOPT)).toEqual({ state: 'carried-out', said: null });
      expect(t.sent()).toEqual(['sent adoption approve', 'sent adoption adopt']);
      /* RED WHEN: the adoption the chain carried out stays open in the company's records. */
      expect(t.kept.kept.find((r) => r.id === ADOPT.proposal)?.status).toBe('executed');
      /* RED WHEN: approving or carrying out a round of the start files a version of the vault's secret or pool. */
      expect(await t.filedSince()).toEqual([0, null]);
    });

    it('an approval the chain already counts builds nothing, and a round short of its bar is not carried out', async () => {
      const t = await start({ mine: true, needed: 3 });
      /* RED WHEN: this seat's approval is built again when the chain already counts it, which the chain refuses. */
      expect(await approveStartRoundHere(t.doors, ADOPT)).toBe('counted');
      /* RED WHEN: an adoption short of its bar is sent to be carried out. */
      expect(await carryStartRoundHere(t.doors, ADOPT)).toEqual({ state: 'waiting', said: null });
      expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
    });

    it('an adoption raised before a signer was removed is refused for good, in words that never say it can be raised again', async () => {
      const t = await start({ stale: true });
      for (const act of [approveStartRoundHere, carryStartRoundHere]) {
        const e = await act(t.doors, ADOPT).then(() => null, (x: unknown) => x as StartRoundRefused);
        /* RED WHEN: a stale adoption is approved or carried out, or refused without the kind a page says it by. */
        expect(e).toBeInstanceOf(StartRoundRefused);
        expect(e!.stoppedAt).toBe(START_STOP.adoptionStale);
        /* RED WHEN: the words lead the person to withdraw it and raise it again, under an identity its approvers can no longer count. */
        expect(e!.message).not.toMatch(/raised again/u);
        expect(e!.message).toMatch(/never carry that adoption out/u);
      }
      expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
    });

    describe('A RUN REPLACING THE VAULT\'S SECRET, RAISED FROM THIS DEVICE', () => {
      const NEXT = `${'5f'.repeat(31)}00`;
      const HELD = 'c4'.repeat(32);

      it('is raised over the commitment the vault holds, for a day, its record carrying each reader\'s own copy, its tree kept in the wallet first', async () => {
        const t = await start({ held: HELD, set: false, noRun: true, records: [adoptionRecord()] });
        const order: string[] = [];
        const doors = { ...t.doors, secretKeptHere: { keep: async () => undefined, held: async () => null, drop: async () => undefined, keepRun: async () => { order.push('kept'); } } };
        t.log.length = 0;
        const out = await raiseASecretRunHere(doors, VAULT as Hex, NEXT as Hex).then(() => 'raised', (e: Error) => e.message);
        expect(out).toBe('raised');
        /* RED WHEN: a replacement is made over zero, as a first secret is: the vault refuses it. */
        expect(t.asked.some((a) => a.previous === HELD)).toBe(true);
        /* RED WHEN: a replacement is given the first secret's fourteen days, so a run nobody carries holds every later one up. */
        expect(t.raised.map((r) => BigInt(r.closesAt) - BigInt(r.opensAt))).toEqual([86_400n + 600n]);
        const rec = t.kept.kept.find((r) => r.chainId === t.raised[0]!.proposal)!;
        const opened = startRecordOpened(VIEWING, rec)!;
        /* RED WHEN: the record leaves out the commitment it replaces or a reader's copy, so no other signer can approve or carry it. */
        expect(opened.previous).toBe(HELD);
        expect(opened.copies?.map((c) => c.reader)).toEqual([t.a.mine]);
        /* RED WHEN: the raise goes out before the copies tree is kept in this wallet. */
        expect(order).toEqual(['kept']);
        expect(t.log).toContain('built propose');
      });

      it('is refused for a vault that holds no secret yet, and for one that already holds this secret, sending nothing', async () => {
        const none = await start({ records: [adoptionRecord()] });
        /* RED WHEN: a vault's first secret is set through a replacement, past its start's own checks. */
        await expect(raiseASecretRunHere(none.doors, VAULT as Hex, NEXT as Hex)).rejects.toThrow(/holds no secret yet/u);
        const set = await start({ held: HELD, set: true, records: [adoptionRecord()] });
        await expect(raiseASecretRunHere(set.doors, VAULT as Hex, NEXT as Hex)).rejects.toThrow(/already holds this secret/u);
        expect([...none.log, ...set.log].filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
      });
    });

    describe('NO FRESH SECRET IS RAISED BESIDE ANOTHER SIGNER\'S RUN THAT MAY STILL SET ONE', () => {
      const MINE = recordsKeypairFrom(new Uint8Array(32).fill(4)).publicKey;
      const OTHER = `${'3e'.repeat(31)}00`;
      const NOW_MS = Date.parse('2026-11-01T12:00:00.000Z');
      /* Bo's record of his own replacement run, sealing a copy of his secret to this signer's key. */
      const bos = (createdAt: string) => {
        const f = signProposalFiling('acc_1', { id: 'prp_bosRunAAAAAA', digest: RUN.payload as Hex, chainId: RUN.proposal as Hex, keyEpoch: 0, createdAt, sealed: sealVaultSecretProposal({
          accountId: 'acc_1', viewingKey: VIEWING, summary: 'Replace the vault\'s secret',
          run: { vault: VAULT as Hex, root: 'b5'.repeat(32) as Hex, payees: '1', opensAt: '1', closesAt: '2', previous: 'c4'.repeat(32) as Hex, copies: [{ reader: MINE as Hex, parts: sealed(OTHER, MINE) as Hex[] }] },
          change: { asset: 'b6'.repeat(32), amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: RUN.salt as Hex }, proposedBy: 'bo',
        }) }, BOS);
        return { ...f, accountId: 'acc_1', status: 'open' as const, approvalCount: 1, createdAt };
      };
      const refusalOf = async (rec: SealedProposal, chain: { landed: boolean; inWindow?: boolean; beforeARemoval?: boolean; unread?: boolean }, mine = `${'5f'.repeat(31)}00`) => {
        const doors = {
          clock: () => NOW_MS, me: { companyKey: new Uint8Array(32).fill(4) }, records: () => ({ get: async () => null }),
          proposals: { accountId: 'acc_1', companyKeys: VIEWING, service: { sealedProposals: async () => [rec] } },
          builder: { startStanding: async (i: { secret?: string; window?: { opensAt: string; closesAt: string } }) => chain.unread === true ? Promise.reject(new Error('the worker stopped')) : ({ standing: { secret: {
            set: false, another: false, held: 'c4'.repeat(32), landed: chain.landed ? [RUN.proposal] : [], rootIsThisRuns: false, written: [], started: false,
            raise: { ...RUN, opensAt: i.window!.opensAt, closesAt: i.window!.closesAt },
            run: chain.landed ? { ...RUN, open: true, approvals: 1, needed: 2, stale: false, opensAt: '1', closesAt: '2', inWindow: chain.inWindow ?? true, beforeARemoval: chain.beforeARemoval ?? false } : null,
          } } }) },
        };
        const at = { chain: { account: ACCOUNT, accountState: '', vaultState: '' }, now: 0n };
        return noOtherRunStanding(doors as never, VAULT as Hex, at as never, { secret: mine as Hex, readers: [MINE as Hex] }).then(() => null, (e: Error) => e.message);
      };

      it('refuses beside a run the chain holds open in its window, and beside one whose raise may still land, naming it; passes over one that can no longer', async () => {
        const recent = new Date(NOW_MS - 3_600_000).toISOString();
        const old = new Date(NOW_MS - 2 * 86_400_000).toISOString();
        /* RED WHEN: a fresh secret is raised while another signer's run, opened from this signer's own copy, may still set one. */
        expect(await refusalOf(bos(old), { landed: true })).toMatch(/prp_bosRunAAAAAA, another run setting a new secret for this vault, open on the chain/u);
        expect(await refusalOf(bos(recent), { landed: false })).toMatch(/whose raise may still reach the chain/u);
        /* RED WHEN: a run that can no longer set a secret holds every later one up. */
        expect(await refusalOf(bos(old), { landed: false })).toBeNull();
        expect(await refusalOf(bos(old), { landed: true, inWindow: false })).toBeNull();
        expect(await refusalOf(bos(old), { landed: true, beforeARemoval: true })).toBeNull();
        /* The run for this very secret is not another one. */
        expect(await refusalOf(bos(recent), { landed: false }, OTHER)).toBeNull();
      });

      it('refuses, naming that the proposals could not be checked, when another run\'s standing cannot be read', async () => {
        /* RED WHEN: a read of another signer's run that fails is taken as that run holding nothing up. */
        expect(await refusalOf(bos(new Date(NOW_MS - 3_600_000).toISOString()), { landed: true, unread: true }))
          .toMatch(/the company's proposals could not be checked against the chain, so no secret run was raised \(the worker stopped\)/u);
      });
    });

    it('a secret run raised before a signer was removed is neither approved nor carried out, and its words say raising it again clears it', async () => {
      const t = await start({ beforeARemoval: true });
      for (const act of [approveStartRoundHere, carryStartRoundHere]) {
        const e = await act(t.doors, SECRET).then(() => null, (x: unknown) => x as StartRoundRefused);
        /* RED WHEN: a run that seals the secret to a seat removed since its raise is approved or carried by this device. */
        expect(e).toBeInstanceOf(StartRoundRefused);
        expect(e!.message).toMatch(/a signer was removed after this secret run was raised/u);
        expect(e!.message).toMatch(/Raising the run again seals it to the signers there are now/u);
      }
      expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
    });

    describe('A RUN REPLACING THE VAULT\'S SECRET, OPENED FROM THIS SIGNER\'S OWN COPY IN BO\'S RECORD', () => {
      const PREVIOUS = 'c4'.repeat(32);
      const NEXT = `${'5d'.repeat(31)}00`;
      /* Bo's record of a run replacing the vault's secret: the commitment it replaces and every reader's own sealed copy. */
      const replacing = (mine: string) => filed('prp_firstSecretB', RUN.proposal, RUN.payload, sealVaultSecretProposal({
        accountId: 'acc_1', viewingKey: VIEWING, summary: 'Replace the vault\'s secret',
        run: { vault: VAULT as Hex, root: 'b5'.repeat(32) as Hex, payees: '1', opensAt: '1', closesAt: '2', previous: PREVIOUS as Hex, copies: [{ reader: mine as Hex, parts: sealed(NEXT, mine) as Hex[] }] },
        change: { asset: 'b6'.repeat(32), amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: RUN.salt as Hex }, proposedBy: 'bo',
      }));
      /* This device's records key: Ada's, from the company key her wallet released. */
      const replacement = async (over: Parameters<typeof start>[0] = {}) =>
        start({ ...over, records: [adoptionRecord(), replacing(recordsKeypairFrom(new Uint8Array(32).fill(4)).publicKey)] });

      it('is made from the secret this signer\'s own copy opens to, over the commitment the record names, and kept in the wallet before it is approved', async () => {
        const t = await replacement();
        const keptRuns: unknown[] = [];
        const doors = { ...t.doors, secretKeptHere: { keep: async () => undefined, held: async () => null, drop: async () => undefined, keepRun: async (_v: Hex, r: unknown) => { keptRuns.push(r); } } };
        /* RED WHEN: the approver reads the secret back from the company's records, which hold only the one it replaces. */
        expect(await approveStartRoundHere(doors, SECRET)).toBe('approved');
        expect(t.asked.at(-1)?.previous).toBe(PREVIOUS);
        /* RED WHEN: the approval goes out before the run's copies tree is kept in this wallet. */
        expect(keptRuns.length).toBe(1);
        /* RED WHEN: the kept tree leaves out the commitment the run replaces, so its copies cannot be written from it. */
        expect((keptRuns[0] as { previous?: string }).previous).toBe(PREVIOUS);
        expect(t.sent()).toEqual(['sent secret-run approve']);
      });

      it('carried out, the secret is set carrying the one the vault last had every copy written for', async () => {
        const t = await replacement({ needed: 1, earlier: { secret: 'e1'.repeat(31) + '00' } });
        expect((await carryStartRoundHere(t.doors, SECRET)).state).toBe('carried-out');
        /* RED WHEN: a replacement is built with zero as its earlier secret, which the vault refuses once a secret took money. */
        expect(t.setWith).toEqual(['e1'.repeat(31) + '00']);
      });

      it('carried out by a device that holds no secret the vault last had every copy written for, nothing is sent, and it says who can carry it', async () => {
        const t = await replacement({ needed: 1, earlier: { unheld: true } });
        await expect(carryStartRoundHere(t.doors, SECRET)).rejects.toThrow(/A signer whose company records or own copy on the chain hold that secret carries the run instead/u);
        expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
      });
    });

    it('an adoption that would leave a vault short of signers who may approve its runs is neither approved nor carried out', async () => {
      const approvers = async () => approverRosterFrom({ threshold: 2, vaultThresholds: [], seated: [{ leaf: 'e1', rights: EVERY_RIGHT }], adoptedVaults: [], companyWide: 'cc'.repeat(32) });
      const t = await start({ approvers, needed: 1 });
      for (const act of [approveStartRoundHere, carryStartRoundHere]) {
        /* RED WHEN: the vault check is skipped when another signer approves or carries out the adoption. */
        expect((await act(t.doors, ADOPT).then(() => null, (x: unknown) => x as StartRoundRefused))?.stoppedAt).toBe(START_STOP.tooFewApprovers);
      }
      expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
    });

    it('a record under the proposal\'s name that is not this vault\'s, as this device makes it, is refused before anything is built', async () => {
      const t = await start({ records: [adoptionRecord('cd'.repeat(32)), secretRecord({ opensAt: '1', closesAt: '3' })] });
      /* RED WHEN: the record is taken for the vault's adoption on its name alone, whatever vault it opens to. */
      await expect(approveStartRoundHere(t.doors, ADOPT)).rejects.toThrow(/no adoption of this vault under that name/u);
      /* RED WHEN: a run whose identity over its window is not the one made from the filed secret is approved. */
      await expect(approveStartRoundHere(t.doors, SECRET)).rejects.toThrow(/not the secret run of this vault/u);
      expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
    });

    it('a set-up record withdrawn for a raise that could no longer land is never approved or carried out as a proposal still standing', async () => {
      const t = await start({ records: [{ ...adoptionRecord(), status: 'cancelled' }, { ...secretRecord(), status: 'cancelled' }] });
      for (const named of [ADOPT, SECRET]) {
        for (const act of [approveStartRoundHere, carryStartRoundHere, startRoundOpenedHere]) {
          /* RED WHEN: a withdrawn record is opened, approved or carried out, counted beside the record that replaced it. */
          await expect(act(t.doors, named), named.round).rejects.toThrow(/withdrawn/u);
        }
      }
      expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
    });

    it('another signer approves the first secret run, with every check the start makes, and carries it out: set, copied and written down', async () => {
      const t = await start();
      const shown: unknown[] = [];
      const reads = t.doors.secretReaders.read;
      t.doors.secretReaders = { ...t.doors.secretReaders, read: async (v, firstSecret) => { shown.push(firstSecret); return reads(v, firstSecret); } };
      expect(await approveStartRoundHere(t.doors, SECRET)).toBe('approved');
      /* RED WHEN: the run is approved without the wallet shown the vault and every reader its secret is sealed to. */
      expect(shown).toEqual([{ readers: [{ key: t.doors.mine, name: 'Ada' }] }]);
      expect(t.sent()).toEqual(['sent secret-run approve']);
      expect(await carryStartRoundHere(t.doors, SECRET)).toEqual({ state: 'carried-out', said: null });
      /* RED WHEN: carrying the run out sets the secret and leaves the signers' sealed copies unwritten, or sends anything else. */
      expect(t.sent()).toEqual(['sent secret-run approve', 'sent secret', 'sent copy']);
      /* RED WHEN: the first secret run, carried out on the chain, stays open in the company's records. */
      expect(t.carried).toEqual([{ id: SECRET.proposal, body: expect.objectContaining({
        vault: VAULT, run: { root: 'b5'.repeat(32), opensAt: '1', closesAt: '2', salt: RUN.salt, nonce: 'bb'.repeat(32), copiesRoot: 'bc'.repeat(32), count: '1' },
      }) }]);
      expect(t.kept.kept.find((r) => r.id === SECRET.proposal)?.status).toBe('executed');
      expect(await t.filedSince()).toEqual([0, null]);
    });

    it('a first secret run is written down only once the chain shows the vault started: on opening it after, and never before', async () => {
      const t = await start({ needed: 3 });
      /* RED WHEN: a run the chain has not carried out is written down as carried out. */
      expect(await startRoundOpenedHere(t.doors, SECRET)).toEqual({ chainId: RUN.proposal, said: null });
      expect(await carryStartRoundHere(t.doors, SECRET)).toEqual({ state: 'waiting', said: null });
      expect(t.carried).toEqual([]);
      t.chain.set = true;
      /* RED WHEN: a run whose secret is set and whose sealed copies are still owed is written down as done, while the vault takes nothing. */
      expect(await startRoundOpenedHere(t.doors, SECRET)).toEqual({ chainId: RUN.proposal, said: null });
      expect(t.carried).toEqual([]);
      t.chain.copied = true;
      /* RED WHEN: a run another device carried out stays open in the company's records after this device opens it. */
      expect(await startRoundOpenedHere(t.doors, SECRET)).toEqual({ chainId: RUN.proposal, said: null });
      expect(t.carried.map((c) => c.id)).toEqual([SECRET.proposal]);
      /* RED WHEN: a round the chain shows done is approved again. */
      expect(await approveStartRoundHere(t.doors, SECRET)).toBe('carried-out');
      expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
    });

    it('a carrying out cut off between the set and the last sealed copy is finished by the next press, and only then written down', async () => {
      const t = await start({ needed: 1, copyFails: 1 });
      /* The set lands; the copy's send fails, and the press stops. */
      await expect(carryStartRoundHere(t.doors, SECRET)).rejects.toThrow(/the page was closed/u);
      expect(t.chain.set).toBe(true);
      expect(t.carried).toEqual([]);
      /* RED WHEN: a run whose copies are still owed is said carried out on the next press, its copies never written from the approval. */
      expect(await approveStartRoundHere(t.doors, SECRET)).toBe('carried-out');
      expect(await finishedSecretRunHere(t.doors, SECRET)).toEqual({ state: 'carried-out', said: null });
      expect(t.sent()).toEqual(['sent secret', 'sent copy']);
      expect(t.carried.map((c) => c.id)).toEqual([SECRET.proposal]);
      /* RED WHEN: the copies of a set secret are written by the carry step without the reader checks. */
      const u = await start({ set: true });
      u.doors.secretReaders = { ...u.doors.secretReaders, read: async () => null };
      await expect(carryStartRoundHere(u.doors, SECRET)).rejects.toBeInstanceOf(StartRoundRefused);
      expect(u.sent()).toEqual([]);
      /* RED WHEN: a run that closed without its secret set is finished as carried out. */
      expect(await finishedSecretRunHere((await start()).doors, SECRET)).toBeNull();
    });

    it('a run for the same secret over another window that the service refuses does not stop the run that set it being written down', async () => {
      const twin = secretRecord({ opensAt: '1', closesAt: '3' }, 'ee'.repeat(32), 'prp_secretTwinAA');
      const t = await start({ records: [twin, adoptionRecord(), secretRecord()], refuse: 'prp_secretTwinAA', set: true });
      t.chain.copied = true;
      const opened = await startRoundOpenedHere(t.doors, SECRET);
      /* RED WHEN: the first record the service refuses stops the loop, and the run that set the secret stays open in the records. */
      expect(t.carried.map((c) => c.id)).toEqual(['prp_secretTwinAA', SECRET.proposal]);
      expect(t.kept.kept.find((r) => r.id === SECRET.proposal)?.status).toBe('executed');
      /* RED WHEN: the record that could not be written down is not named. */
      expect(opened.said).toMatch(/^prp_secretTwinAA: /u);
    });

    it('a first secret run whose window has passed is not approved', async () => {
      const t = await start({ inWindow: false });
      /* RED WHEN: a run the account would refuse to carry out is approved. */
      await expect(approveStartRoundHere(t.doors, SECRET)).rejects.toThrow(/has passed/u);
      expect(t.log.filter((l) => l.startsWith('built') || l.startsWith('sent '))).toEqual([]);
    });
  });
});

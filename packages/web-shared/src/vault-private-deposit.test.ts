import {
  DEPOSIT_CLOCKS_MAY_DIFFER_MS,
  DEPOSIT_TIME_TO_LIVE_MS,
  type DepositInFlight,
  DepositLandedNotYetRecorded,
  DepositNotAsBuilt,
  DepositNotSent,
  DepositNotYetSeen,
  DepositStillInFlight,
  depositIntoCompanyVault,
  settleDepositInFlight
} from './vault-private-deposit.js';
import { VaultNotReadHere } from './vault-start-stops.js';
import { type VaultService } from './vault-service.js';
import { openCompanyVaultPool } from './vault-pool-opened.js';
import { DepositCoinAlreadyMade, depositNonceAt } from '../../../src/midnight/deposit-nonce.js';
import { type Hex } from '../../../src/core/crypto.js';
import { type Kept, inFlightInMemory as inFlightInMemoryRecords } from './in-flight-on-this-device.js';
import { MemorySealedPoolStore, SealedNotePool } from '../../../src/midnight/vault-pool.js';
import { type WireRecord } from '../../../src/midnight/sealed-record-wire.js';
import { VaultAskFailed, type VaultBuilderClient, vaultBuilderOver } from './vault-worker-client.js';
import { answerVaultAsk, creatingTransactionOfNote } from './vault-worker-entry.js';
import { coinsKeptOnThisDevice } from './vault-coins-kept-here.js';
import {
  currentDepositNonceKey,
  openNonceSecrets,
  recordsKeypairFrom
} from '../../../src/midnight/company-nonce-secret.js';
import { describe, expect, it } from 'vitest';
import { VaultSecretBeingChanged } from './deposit-on-device.js';
import * as vaultModule from '../../../contracts/managed-vault/contract/index.js';
import { vaultNoteCommitment } from '../../../src/midnight/note-index.js';
import {
  ACCOUNT,
  type ChainBehind,
  LABEL,
  PARAMS,
  VAULT,
  aServiceThatLies,
  builder,
  committee,
  inFlightInMemory,
  indexerOf,
  nothingToCheck,
  oneKey,
  pacing,
  readOnTheDevice,
  serviceFrom,
  theServiceNeverAsked,
  view,
  walletKey,
  walletReadsTheVault
} from './vault-operation.test-support.js';

describe('THE POOL AND A DEPOSIT', () => {
  const wrapping = recordsKeypairFrom(new Uint8Array(32).fill(3));
  const me = { signerId: 'ada', wrappingSecret: wrapping.secret, companyKey: new Uint8Array(32).fill(3) };
  const stores = () => {
    const s = new Map<WireRecord, MemorySealedPoolStore>();
    return (r: WireRecord) => s.get(r) ?? s.set(r, new MemorySealedPoolStore()).get(r)!;
  };
  const poolDoors = (service: VaultService, records = stores()) => ({
    ...pacing,
    ...walletReadsTheVault,
    service,
    indexer: indexerOf(service),
    builder: { vaultOnChain: readOnTheDevice },
    me,
    myRecordsKey: 'ff'.repeat(32),
    records,
    signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }]
  });

  /* RED WHEN: a nonce secret can be filed with no check of who it is wrapped to - the check made optional again. */
  it('A NONCE SECRET IS NEVER FILED WITHOUT THE CHECK OF WHO IT IS WRAPPED TO', async () => {
    const records = stores();
    const ready = view({ heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [] });
    await expect(
      openCompanyVaultPool(poolDoors(serviceFrom([ready], []), records), VAULT, undefined as never)
    ).rejects.toThrow();
    expect(await records('nonce-secret').get(VAULT)).toBeNull();
    /* RED WHEN: the pool is filed before the check, so the service's refusal of it speaks before the check's own words. */
    const refused = async () => {
      throw new Error('the readers were refused');
    };
    await expect(openCompanyVaultPool(poolDoors(serviceFrom([ready], []), records), VAULT, refused)).rejects.toThrow(
      /the readers were refused/
    );
    expect(await records('pool').get(VAULT)).toBeNull();
    expect(await records('nonce-secret').get(VAULT)).toBeNull();
    const seen: string[][] = [];
    await openCompanyVaultPool(
      poolDoors(
        serviceFrom([ready], [], { keys: async () => ({ committee, why: null, readers: ['6d'.repeat(32)] }) }),
        records
      ),
      VAULT,
      async (readers) => {
        seen.push([...readers]);
      },
      undefined,
      undefined,
      async () => ['5C'.repeat(32) as Hex]
    );
    /* RED WHEN: the readers a new secret is checked and sealed to are the service's list, not the directory's. */
    expect(seen).toEqual([['5c'.repeat(32)]]);
  });

  it("A NEW VAULT'S SECRET KEPT ON THIS DEVICE IS FILED AGAIN WHEN THE RECORDS HOLD NONE, AND IS KNOWN AS MADE HERE WHEN READ BACK", async () => {
    const ready = view({ heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [] });
    const keptMap = new Map<string, unknown>();
    const kept = {
      keep: async (v: string, p: unknown) => {
        keptMap.set(v, p);
      },
      held: async (v: string) => (keptMap.get(v) ?? null) as never,
      drop: async (v: string) => {
        keptMap.delete(v);
      }
    };
    const first = stores();
    const made = await openCompanyVaultPool(
      { ...poolDoors(serviceFrom([ready], []), first), secretKeptHere: kept as never },
      VAULT,
      nothingToCheck
    );
    expect(made.madeHere).toBe(true);
    const filed = await first('nonce-secret').get(VAULT);
    await kept.keep(VAULT, filed);
    /* RED WHEN: a secret this device kept, which the service did not file, is replaced by a new one, so a vault whose commitment names it can never be finished. */
    const lost = stores();
    let readersAsked = 0;
    const again = await openCompanyVaultPool(
      {
        ...poolDoors(
          serviceFrom([ready], [], {
            keys: async () => {
              readersAsked += 1;
              return { committee, why: null, readers: [] };
            }
          }),
          lost
        ),
        secretKeptHere: kept as never
      },
      VAULT,
      nothingToCheck
    );
    expect([again.secret, again.madeHere]).toEqual([made.secret, true]);
    expect(await lost('nonce-secret').get(VAULT)).toEqual(filed);
    expect(readersAsked).toBe(0);
    /* RED WHEN: a secret read back from the records that this device kept is taken as one it only read back, so its first secret run cannot be raised from here. */
    const back = await openCompanyVaultPool(
      { ...poolDoors(serviceFrom([ready], []), lost), secretKeptHere: kept as never },
      VAULT,
      nothingToCheck
    );
    expect([back.secret, back.madeHere]).toEqual([made.secret, true]);
    const elsewhere = await openCompanyVaultPool(poolDoors(serviceFrom([ready], []), lost), VAULT, nothingToCheck);
    expect(elsewhere.madeHere).toBe(false);
  });

  it('A SECRET THE CHAIN ALREADY HOLDS IS NEVER MADE AFRESH, AND THE ONE THIS WALLET KEPT IS FILED AGAIN AS THE NEWEST WHEN THE CHAIN SHOWS IT', async () => {
    /* Device A made the secret and kept it; its page withheld the filing; the secret was set on the chain. */
    const ready = view({ heldByCommittee: true, state: 'AAAA', notes: [], everCreated: [] });
    const set = view({
      heldByCommittee: true,
      state: 'AAAA',
      notes: [],
      everCreated: [],
      nonceCommitment: '5c'.repeat(32)
    });
    const keptMap = new Map<string, unknown>();
    const kept = {
      keep: async (v: string, p: unknown) => {
        keptMap.set(v, p);
      },
      held: async (v: string) => (keptMap.get(v) ?? null) as never,
      drop: async (v: string) => {
        keptMap.delete(v);
      }
    };
    const onA = stores();
    const made = await openCompanyVaultPool(
      { ...poolDoors(serviceFrom([ready], []), onA), secretKeptHere: kept as never },
      VAULT,
      nothingToCheck
    );
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
    const back = await openCompanyVaultPool(
      { ...poolDoors(serviceFrom([set], []), service), secretKeptHere: kept as never },
      VAULT,
      nothingToCheck,
      theChains
    );
    /* RED WHEN: the secret this wallet kept, which the chain shows, is passed over for the records' other one, so the vault's copies are never written. */
    expect([back.secret, back.madeHere]).toEqual([made.secret, true]);
    /* RED WHEN: the kept secret is used but not filed again as the newest, so every other device still reads the one the chain does not hold. */
    expect(
      (await openCompanyVaultPool(poolDoors(serviceFrom([set], []), service), VAULT, nothingToCheck, theChains)).secret
    ).toBe(made.secret);
    /* RED WHEN: a kept secret the chain does not show is filed over a vault whose secret is set. */
    const none = stores();
    await expect(
      openCompanyVaultPool(
        { ...poolDoors(serviceFrom([set], []), none), secretKeptHere: kept as never },
        VAULT,
        nothingToCheck,
        async () => false
      )
    ).rejects.toThrow(/already holds a secret/);
    expect(await none('nonce-secret').get(VAULT)).toBeNull();
  });

  it('A POOL IS OPENED FOR A VAULT PINNED TO THE ACCOUNT WHATEVER KEYS HOLD IT, AND NO EMPTY ONE FOR A VAULT WITH MONEY', async () => {
    /* RED WHEN: opening a vault's pool reads who holds the vault - a committee change left half done would then stop it. */
    await openCompanyVaultPool(poolDoors(serviceFrom([oneKey], [])), VAULT, nothingToCheck);
    const records = stores();
    await expect(
      openCompanyVaultPool(
        poolDoors(serviceFrom([view({ heldByCommittee: true, everCreated: ['01'] })], []), records),
        VAULT,
        nothingToCheck
      )
    ).rejects.toThrow(/already put money in this vault and it has no pool/);
    expect(await records('pool').get(VAULT)).toBeNull();
  });

  it("A PRIVATE DEPOSIT INTO A VAULT WHOSE COMMITTEE DIFFERS FROM THE ACCOUNT'S GOES AHEAD WHILE THE VAULT IS PINNED TO THE ACCOUNT", async () => {
    const log: string[] = [];
    const records = stores();
    /* Started and pinned to the company's account, and held by other keys than the account is, as the chain shows both. */
    const otherKeys = view({ heldByCommittee: false, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([otherKeys], log), records), VAULT, nothingToCheck);
    const e = await depositIntoCompanyVault(
      {
        ...poolDoors(serviceFrom([otherKeys], log), records),
        company: LABEL,
        account: ACCOUNT,
        inFlight: inFlightInMemory(),
        builder: builder(log),
        pay: async () => {
          log.push('paid');
          return { transaction: 'X', leaves: [] };
        }
      },
      VAULT,
      { token: 'ab'.repeat(32), value: 7n }
    ).catch((x) => x);
    /* RED WHEN: a deposit reads who holds the vault - a committee change the service leaves half done would then stop every deposit. */
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    /* The block is read for the deposit's parameters, for the account's count of removals, and for the count again before it is sent. */
    expect(log).toEqual([
      'read the block here',
      'read the block here',
      `build deposit with ${PARAMS}`,
      'paid',
      'read the block here',
      'sent deposit'
    ]);
  });

  it("A DEPOSIT WHOSE COIN'S COMMITMENTS CANNOT BE WORKED OUT AFTER ITS BUILD STOPS BEFORE THE WALLET IS ASKED, HOLDING NOTHING", async () => {
    /* RED WHEN: the coin's commitments are worked out after the send - a vault worker that stops then reads as a failure, not as a deposit that may have been sent. */
    const log: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
    const base = builder(log);
    let built = false;
    const stopsAfterTheBuild: VaultBuilderClient = {
      ...base,
      deposit: async (input) => {
        const done = await base.deposit(input);
        built = true;
        return done;
      },
      commitments: async (input) => {
        if (built)
          throw new VaultAskFailed(
            'commitments',
            'stopped',
            'the part of this page that builds and proves vault transactions stopped before it answered.'
          );
        return base.commitments(input);
      }
    };
    const inFlight = inFlightInMemory<never>();
    const e = await depositIntoCompanyVault(
      {
        ...poolDoors(serviceFrom([ready], log), records),
        company: LABEL,
        account: ACCOUNT,
        inFlight,
        builder: stopsAfterTheBuild,
        pay: async () => {
          log.push('paid');
          return { transaction: 'X', leaves: [] };
        }
      },
      VAULT,
      { token: 'ab'.repeat(32), value: 7n }
    ).catch((x) => x);
    expect(e).toBeInstanceOf(VaultAskFailed);
    expect(log).not.toContain('paid');
    expect(log).not.toContain('sent deposit');
    expect(await inFlight.get(VAULT)).toBeNull();
  });

  it("A DEPOSIT INTO A VAULT THE ACCOUNT HAS NOT ADOPTED, AS THE SIGNER'S OWN WALLET READS IT, IS REFUSED BEFORE A COIN IS CHOSEN", async () => {
    const log: string[] = [];
    const records = stores();
    const fundableView = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([fundableView], log), records), VAULT, nothingToCheck);
    const e = await depositIntoCompanyVault(
      {
        ...poolDoors(serviceFrom([fundableView], log), records),
        company: LABEL,
        account: ACCOUNT,
        inFlight: inFlightInMemory(),
        builder: builder(log),
        onChain: async (v: string) => ({
          ...(await walletReadsTheVault.onChain(v)),
          holders: { ...(await walletReadsTheVault.onChain(v)).holders, adoptedVaults: [] }
        }),
        pay: async () => {
          log.push('paid');
          return { transaction: 'X', leaves: [] };
        }
      },
      VAULT,
      { token: 'ab'.repeat(32), value: 7n }
    ).catch((x: Error) => x);
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
    await expect(
      depositIntoCompanyVault(
        {
          ...poolDoors(serviceFrom([notStarted], log), records),
          company: LABEL,
          account: ACCOUNT,
          inFlight: inFlightInMemory(),
          builder: builder(log),
          pay: async () => {
            log.push('paid');
            return { transaction: 'X', leaves: [] };
          }
        },
        VAULT,
        { token: 'ab'.repeat(32), value: 7n }
      )
    ).rejects.toThrow(/this vault has not been started/);
    expect(log).toEqual([]);
    expect(await records('deposit-journal').get(VAULT)).toBeNull();
    /*
     * The company's account held by other keys, or at another threshold, than the vault, as the signer's own wallet
     * reads it. RED WHEN: who holds the vault is compared with who holds the account - a committee change the service
     * leaves half done would then stop every deposit.
     */
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    const temporary = async (v: string) => ({
      ...(await walletReadsTheVault.onChain(v)),
      holders: {
        ...(await walletReadsTheVault.onChain(v)).holders,
        committee: [{ tag: 'schnorr', value: walletKey(0x77) }]
      }
    });
    const two = async (v: string) => ({
      ...(await walletReadsTheVault.onChain(v)),
      holders: { ...(await walletReadsTheVault.onChain(v)).holders, threshold: 2 }
    });
    for (const onChain of [temporary, two]) {
      const goes: string[] = [];
      const own = stores();
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], goes), own), VAULT, nothingToCheck);
      const e = await depositIntoCompanyVault(
        {
          ...poolDoors(serviceFrom([ready], goes), own),
          onChain,
          company: LABEL,
          account: ACCOUNT,
          inFlight: inFlightInMemory(),
          builder: builder(goes),
          pay: async () => {
            goes.push('paid');
            return { transaction: 'X', leaves: [] };
          }
        },
        VAULT,
        { token: 'ab'.repeat(32), value: 7n }
      ).catch((x) => x);
      expect(e).toBeInstanceOf(DepositNotYetSeen);
      expect(goes).toContain('paid');
    }
  });

  it("A DEPOSIT IS BUILT ON THE PARAMETERS THIS DEVICE READ AT THE WALLET'S INDEXER; WHAT THE SERVICE WOULD SERVE IS NEVER ASKED", async () => {
    const log: string[] = [];
    const asked: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
    const doors = poolDoors(serviceFrom([ready], log), records);
    await depositIntoCompanyVault(
      {
        ...doors,
        service: aServiceThatLies(doors.service, asked),
        company: LABEL,
        account: ACCOUNT,
        inFlight: inFlightInMemory(),
        builder: builder(log),
        pay: async () => {
          log.push('paid');
          return { transaction: 'X', leaves: [] };
        }
      },
      VAULT,
      { token: 'ab'.repeat(32), value: 7n }
    ).catch(() => undefined);
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
    const e = await depositIntoCompanyVault(
      {
        ...poolDoors(serviceFrom([ready], log), records),
        company: LABEL,
        account: ACCOUNT,
        inFlight: inFlightInMemory(),
        builder: builder(log),
        pay: async () => {
          log.push('paid');
          return { transaction: 'X', leaves: [] };
        }
      },
      VAULT,
      { token: 'ab'.repeat(32), value: 7n }
    ).catch((x) => x);
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    /* RED WHEN: the deposit is built with anything but the parameters the block read served, or the block is not read. */
    /* The block is read for the deposit's parameters, for the account's count of removals, and for the count again before it is sent. */
    expect(log).toEqual([
      'read the block here',
      'read the block here',
      `build deposit with ${PARAMS}`,
      'paid',
      'read the block here',
      'sent deposit'
    ]);
    expect((await records('pool').versions(VAULT)).length).toBe(1);
    expect(await records('deposit-journal').get(VAULT)).not.toBeNull();
  });

  it('A DEPOSIT IS NOT SENT WHEN A REMOVAL IS COUNTED WHILE IT IS BUILT AND PAID FOR', async () => {
    const log: string[] = [];
    const records = stores();
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
    const counts = [0, 1];
    const counting = {
      ...builder(log),
      startStanding: async () => ({ standing: { adopted: true, removals: counts.shift() ?? 1 } }) as never
    };
    const e = await depositIntoCompanyVault(
      {
        ...poolDoors(serviceFrom([ready], log), records),
        company: LABEL,
        account: ACCOUNT,
        inFlight: inFlightInMemory(),
        builder: counting,
        pay: async () => {
          log.push('paid');
          return { transaction: 'X', leaves: [] };
        }
      },
      VAULT,
      { token: 'ab'.repeat(32), value: 7n }
    ).catch((x) => x);
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
        const a = await answerVaultAsk(async () => ({ vault: vaultModule }) as never, {
          id: 1,
          network: 'undeployed',
          ask: 'commitments',
          ...i
        });
        if (!a.ok || a.ask !== 'commitments') throw new Error('the worker did not answer the commitments');
        return { output: a.output, held: a.held };
      }
    });
    const money = { token: 'ab'.repeat(32) as never, value: 7n };
    const coinAt = async (records: ReturnType<typeof stores>, slot: number) => {
      const opened = openNonceSecrets(
        (await records('nonce-secret').get(VAULT))!,
        VAULT,
        recordsKeypairFrom(me.companyKey)
      );
      const nonce = depositNonceAt(currentDepositNonceKey(opened), money, slot);
      return { nonce, token: money.token, value: money.value };
    };
    /* Three coins the chain made, at slots 1, 2 and 3, and the vault holds the coins at 4, 5 and 6 now: with three
     * outputs in the history, 6 is the last slot a deposit may use. */
    const records = stores();
    const empty = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([empty], []), records), VAULT, nothingToCheck);
    const madeAt = async (slots: number[]) =>
      Promise.all(slots.map(async (n) => vaultNoteCommitment(await coinAt(records, n), VAULT as never)));
    const log: string[] = [];
    const heldAt = async (slots: number[]) =>
      Promise.all(
        slots.map(
          async (n) =>
            (
              await real([]).commitments({
                vault: VAULT,
                coin: { ...(await coinAt(records, n)), value: money.value.toString() }
              })
            ).held
        )
      );
    const taken = view({
      heldByCommittee: true,
      started: true,
      state: 'AAAA',
      notes: await heldAt([4, 5, 6]),
      everCreated: await madeAt([1, 2, 3])
    });
    const e = await depositIntoCompanyVault(
      {
        ...poolDoors(serviceFrom([taken], log), records),
        company: LABEL,
        account: ACCOUNT,
        inFlight: inFlightInMemory(),
        builder: real(log),
        pay: async () => {
          log.push('paid');
          return { transaction: 'X', leaves: [] };
        }
      },
      VAULT,
      money
    ).catch((x) => x);
    /* RED WHEN: the worker's `output` is not the ledger's commitment (the held one, say), or the history is not asked. */
    expect(e).toBeInstanceOf(DepositCoinAlreadyMade);
    expect(log, 'RED WHEN: a coin the ledger has recorded reaches the builder or the wallet').toEqual([
      'read the block here',
      'read the block here'
    ]);

    /* Two of the three taken: the deposit moves to the free slot and builds with that coin. */
    const log2: string[] = [];
    const built: string[] = [];
    const two = view({
      heldByCommittee: true,
      started: true,
      state: 'AAAA',
      notes: [],
      everCreated: [...(await madeAt([1, 3])), 'f1'.repeat(32)]
    });
    await depositIntoCompanyVault(
      {
        ...poolDoors(serviceFrom([two], log2), records),
        company: LABEL,
        account: ACCOUNT,
        inFlight: inFlightInMemory(),
        builder: {
          ...real(log2),
          deposit: async (i) => {
            built.push(i.coin.nonce);
            return { tx: 'P' };
          }
        },
        pay: async () => ({ transaction: 'X', leaves: [] })
      },
      VAULT,
      money
    ).catch(() => undefined);
    expect(built, 'RED WHEN: a slot whose coin the ledger recorded is used, or a free one is skipped').toEqual([
      (await coinAt(records, 2)).nonce
    ]);
  });

  it("EACH DEPOSIT CHOOSES ITS COIN FROM THE COUNT OF COINS THE CHAIN SHOWS WHEN THAT DEPOSIT STARTS, NEVER FROM THE PREVIOUS ONE'S READ", async () => {
    /*
     * RED WHEN: a second deposit takes the coins the chain ever made from the read taken for the first deposit, so a
     * coin the chain made in between is built again.
     */
    const real = (log: string[]): VaultBuilderClient => ({
      ...builder(log),
      commitments: async (i) => {
        const a = await answerVaultAsk(async () => ({ vault: vaultModule }) as never, {
          id: 1,
          network: 'undeployed',
          ask: 'commitments',
          ...i
        });
        if (!a.ok || a.ask !== 'commitments') throw new Error('the worker did not answer the commitments');
        return { output: a.output, held: a.held };
      }
    });
    const money = { token: 'ab'.repeat(32) as never, value: 7n };
    const coinAt = async (records: ReturnType<typeof stores>, slot: number) => {
      const opened = openNonceSecrets(
        (await records('nonce-secret').get(VAULT))!,
        VAULT,
        recordsKeypairFrom(me.companyKey)
      );
      const nonce = depositNonceAt(currentDepositNonceKey(opened), money, slot);
      return { nonce, token: money.token, value: money.value };
    };
    const records = stores();
    const empty = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    await openCompanyVaultPool(poolDoors(serviceFrom([empty], []), records), VAULT, nothingToCheck);
    const built: string[] = [];
    const attempt = async (chain: ReturnType<typeof view>) => {
      const log: string[] = [];
      await depositIntoCompanyVault(
        {
          ...poolDoors(serviceFrom([chain], log), records),
          company: LABEL,
          account: ACCOUNT,
          inFlight: inFlightInMemory(),
          builder: {
            ...real(log),
            deposit: async (i) => {
              built.push(i.coin.nonce);
              return { tx: 'P' };
            }
          },
          pay: async () => {
            throw new Error('the wallet was not asked in this test');
          }
        },
        VAULT,
        money
      ).catch(() => undefined);
    };
    await attempt(empty);
    const firstSlot = (await coinAt(records, 1)).nonce;
    expect(built, 'the first deposit did not take the first free slot').toEqual([firstSlot]);
    const madeNow = view({
      heldByCommittee: true,
      started: true,
      state: 'AAAA',
      notes: [],
      everCreated: [await vaultNoteCommitment(await coinAt(records, 1), VAULT as never)]
    });
    await attempt(madeNow);
    expect(built, 'the second deposit built the coin the chain had made since the first').toEqual([
      firstSlot,
      (await coinAt(records, 2)).nonce
    ]);
  });

  it('A DEPOSIT WHOSE CHAIN PARAMETERS CANNOT BE READ CHOOSES NO COIN, BUILDS NOTHING AND ASKS NO WALLET', async () => {
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    const COULD_NOT_READ =
      /^the chain's current parameters could not be read for this vault, so no coin was chosen and nothing was built or sent/;
    const ANSWERED_WRONGLY =
      /^the chain your wallet reads answered with something other than this vault's current parameters \(.+\), so no coin was chosen and nothing was built or sent/;
    const refusals: Array<[string, Partial<ChainBehind>]> = [
      [
        'the block cannot be read',
        {
          payoutState: async () => {
            throw new Error('the chain could not be read');
          }
        }
      ],
      [
        'the block names no parameters',
        {
          payoutState: async (v) => ({
            vault: v,
            account: ACCOUNT,
            blockHash: 'B1',
            vaultState: 'V',
            zswapState: 'Z',
            parameters: '',
            accountState: 'A'
          })
        }
      ],
      [
        "the block's parameters are not parameters",
        {
          payoutState: async (v) => ({
            vault: v,
            account: ACCOUNT,
            blockHash: 'B1',
            vaultState: 'V',
            zswapState: 'Z',
            parameters: btoa('not parameters at all, just bytes'),
            accountState: 'A'
          })
        }
      ],
      [
        "the block's parameters are not base64",
        {
          payoutState: async (v) => ({
            vault: v,
            account: ACCOUNT,
            blockHash: 'B1',
            vaultState: 'V',
            zswapState: 'Z',
            parameters: '%%%%',
            accountState: 'A'
          })
        }
      ]
    ];
    for (const [why, over] of refusals) {
      const log: string[] = [];
      const records = stores();
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
      /* RED WHEN: the parameters are read after the coin is chosen, or a failed or foreign read is let through -
       * the journal then holds a coin, and the log carries 'build deposit' or 'paid'. */
      const said = await depositIntoCompanyVault(
        {
          ...poolDoors(serviceFrom([ready], log, over), records),
          company: LABEL,
          account: ACCOUNT,
          inFlight: inFlightInMemory(),
          builder: builder(log),
          pay: async () => {
            log.push('paid');
            return { transaction: 'X', leaves: [] };
          }
        },
        VAULT,
        { token: 'ab'.repeat(32), value: 7n }
      ).then(
        () => 'it went ahead',
        (x: Error) => x.message
      );
      /* RED WHEN: a block that cannot be read is called an answer the service got wrong, or the other way round. */
      expect(said, why).toMatch(why === 'the block cannot be read' ? COULD_NOT_READ : ANSWERED_WRONGLY);
      /* RED WHEN: any of a deposit's own refusals is worded for a payment. */
      expect(said, why).not.toMatch(/paid out|payment/i);
      expect(
        log.filter((l) => l !== 'read the block here'),
        why
      ).toEqual([]);
      expect(await records('deposit-journal').get(VAULT), why).toBeNull();
    }
  });

  it("A DEPOSIT'S REFUSAL CARRIES NONE OF THE PAYMENT ROUTE'S WORDS WHEN THE BLOCK CANNOT BE READ", async () => {
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    /* What the route the block is read through answers when it refuses, word for word. */
    const routeSays = [
      'this company has no contract on the chain this service can read, so nothing can be paid out.',
      'this deployment reads no chain, so nothing can be paid out.',
      'the chain could not be read for this payment: the indexer is down'
    ];
    for (const said of routeSays) {
      const log: string[] = [];
      const records = stores();
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
      const e = await depositIntoCompanyVault(
        {
          ...poolDoors(
            serviceFrom([ready], log, {
              payoutState: async () => {
                throw new Error(said);
              }
            }),
            records
          ),
          company: LABEL,
          account: ACCOUNT,
          inFlight: inFlightInMemory(),
          builder: builder(log),
          pay: async () => {
            log.push('paid');
            return { transaction: 'X', leaves: [] };
          }
        },
        VAULT,
        { token: 'ab'.repeat(32), value: 7n }
      ).catch((x: Error) => x);
      expect((e as Error).message, said).toMatch(/current parameters could not be read.*no coin was chosen/);
      /* RED WHEN: the route's own refusal is carried into the deposit's, so a deposit says nothing can be paid out. */
      expect((e as Error).message, said).not.toMatch(/paid out|payment/i);
      expect(
        log.filter((l) => l !== 'read the block here'),
        said
      ).toEqual([]);
      expect(await records('deposit-journal').get(VAULT), said).toBeNull();
    }
  });

  it("PARAMETERS OF A VERSION THIS PAGE DOES NOT BUILD WITH ARE REFUSED BEFORE A COIN'S JOURNAL LINE IS FILED", async () => {
    const ready = view({ heldByCommittee: true, started: true, state: 'AAAA', notes: [], everCreated: [] });
    for (const other of ['v7', 'v9', 'v80', 'v']) {
      const log: string[] = [];
      const records = stores();
      const served = btoa(`midnight:ledger-parameters[${other}]:stand-in`);
      await openCompanyVaultPool(poolDoors(serviceFrom([ready], log), records), VAULT, nothingToCheck);
      const e = await depositIntoCompanyVault(
        {
          ...poolDoors(
            serviceFrom([ready], log, {
              payoutState: async (v) => ({
                vault: v,
                account: ACCOUNT,
                blockHash: 'B1',
                vaultState: 'V',
                zswapState: 'Z',
                parameters: served,
                accountState: 'A'
              })
            }),
            records
          ),
          company: LABEL,
          account: ACCOUNT,
          inFlight: inFlightInMemory(),
          builder: builder(log),
          pay: async () => {
            log.push('paid');
            return { transaction: 'X', leaves: [] };
          }
        },
        VAULT,
        { token: 'ab'.repeat(32), value: 7n }
      ).catch((x: Error) => x);
      /* RED WHEN: only the header's start is checked, so another version reaches the worker after the journal line is filed. */
      expect((e as Error).message, other).toMatch(
        /different ledger version from the one this page builds deposits with, so no coin was chosen, nothing was built or sent/
      );
      expect((e as Error).message, other).not.toMatch(/paid out|payment/i);
      expect(
        log.filter((l) => l !== 'read the block here'),
        other
      ).toEqual([]);
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
      notes: [] as string[],
      everCreated: [] as string[],
      events: new Map<
        string,
        Array<{
          transactionHash: string;
          details: { tag: string; commitment?: string; contract?: string; mtIndex?: string };
        }>
      >(),
      sent: [] as string[],
      asked: [] as string[],
      built: [] as Coin[],
      eventReads: 0,
      depositAnswer: { txRef: 'p', transactionHash: HASH as string | null },
      sendFails: null as null | Error,
      lookups: 0,
      historyUnreadable: false
    };
    const service = serviceFrom([], w.asked, {
      chain: async () =>
        view({
          heldByCommittee: true,
          started: true,
          state: 'AAAA',
          notes: [...w.notes],
          everCreated: [...w.everCreated]
        }),
      deposit: async (_v, tx) => {
        if (w.sendFails) throw w.sendFails;
        w.sent.push(tx);
        return w.depositAnswer;
      },
      events: async (_v, tx) => {
        w.eventReads += 1;
        const e = w.events.get(tx);
        if (e === undefined) throw new Error('the indexer does not hold this transaction yet');
        return { events: e };
      },
      /* The vault's own history, newest first, searched by an output's commitment. */
      createdBy: async (_v, commitment) => {
        w.lookups += 1;
        if (w.historyUnreadable) throw new Error("the indexer could not list this vault's transactions");
        for (const [hash, events] of [...w.events].reverse()) {
          if (
            events.some(
              (e) =>
                e.details.tag === 'zswapOutput' && e.details.commitment === commitment && e.details.contract === VAULT
            )
          ) {
            return { transactionHash: hash, events };
          }
        }
        return null;
      }
    });
    const b: VaultBuilderClient = {
      ...builder([]),
      deposit: async (i) => {
        w.built.push(i.coin);
        return { tx: `P${w.built.length}` };
      },
      commitments: async (i) => ({ output: outputOf(i.coin), held: heldOf(i.coin) }),
      /* The deposit built `P<n>`, and what the wallet hands back for it, create the one coin built n-th. */
      readTransaction: async (i) => ({
        ...(await builder([]).readTransaction!(i))!,
        coinsForContracts: coinsBuilt(w.built, i.transaction)
      })
    };
    /** The chain takes the deposit of `coin` in transaction `hash`. */
    const lands = (coin: Coin, hash = HASH) => {
      w.notes.push(heldOf(coin));
      w.everCreated.push(outputOf(coin));
      w.events.set(hash, [
        {
          transactionHash: hash,
          details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '4' }
        }
      ]);
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
      ...pacing,
      ...walletReadsTheVault,
      service: t.service,
      indexer: indexerOf(t.service),
      me,
      myRecordsKey: 'ff'.repeat(32),
      records,
      signers: async () => [{ id: 'ada', wrappingPublicKey: wrapping.publicKey }],
      company: LABEL,
      account: ACCOUNT,
      builder: t.b,
      inFlight: inFlightInMemory(kept),
      clock: () => now,
      pay: async (ask: { transaction: string }) => ({ transaction: `${ask.transaction}+coins`, leaves: [] })
    };
    await openCompanyVaultPool(doors, VAULT, nothingToCheck);
    const pool = new SealedNotePool(records('pool'), { signerId: 'ada', wrappingSecret: wrapping.secret }, async () => [
      { id: 'ada', wrappingPublicKey: wrapping.publicKey }
    ]);
    return {
      ...t,
      doors,
      records,
      kept,
      pool,
      later: (ms: number) => {
        now += ms;
      }
    };
  };

  /* What the wallet hands back in place of the deposit built here: each one changes the read of it, or cannot be read. */
  const theCall = { address: VAULT, entryPoint: 'payout', segments: [1] };
  for (const [why, handedBack] of [
    ['without the coin built', () => ({ coinsForContracts: [] })],
    [
      'with the coin built twice',
      (own: { contract: string; commitment: string }) => ({ coinsForContracts: [own, own] })
    ],
    [
      'with the coin made for another vault',
      (own: { contract: string; commitment: string }) => ({
        coinsForContracts: [{ ...own, contract: 'ef'.repeat(32) }]
      })
    ],
    [
      'with a coin of another amount',
      (own: { contract: string; commitment: string }) => ({
        coinsForContracts: [{ ...own, commitment: own.commitment.replace(/:7$/u, ':8') }]
      })
    ],
    [
      'with a coin of another token',
      (own: { contract: string; commitment: string }) => ({
        coinsForContracts: [{ ...own, commitment: own.commitment.replace(MONEY.token, 'cd'.repeat(32)) }]
      })
    ],
    [
      'with the coin built made and spent again inside it',
      (own: { contract: string; commitment: string }) => ({ coinsForContracts: [{ ...own, madeAndSpent: true }] })
    ],
    [
      'with a coin for another contract beside it',
      (own: { contract: string; commitment: string }) => ({
        coinsForContracts: [own, { contract: 'ef'.repeat(32), commitment: 'e3'.repeat(32) }]
      })
    ],
    [
      'with a call more than was built',
      () => ({ calls: [theCall, { address: 'ef'.repeat(32), entryPoint: 'payout', segments: [2] }] })
    ],
    ['without the call built', () => ({ calls: [] })],
    [
      'with public money taken in',
      () => ({ publicTakes: [{ address: VAULT, entryPoint: 'deposit', colour: 'cd'.repeat(32), amount: '1' }] })
    ],
    ['with coins that cannot be read', () => ({ coinsForContracts: null })],
    ['with public takes that cannot be read', () => ({ publicTakes: null })],
    ['that cannot be read at all', () => null]
  ] as const) {
    it(`A DEPOSIT THE WALLET HANDS BACK ${why.toUpperCase()} IS NOT SENT, AND THIS BROWSER LETS IT GO`, async () => {
      const t = await setUp();
      const stages: string[] = [];
      const honest = t.doors.builder.readTransaction!;
      const e = await depositIntoCompanyVault(
        {
          ...t.doors,
          progress: (s: string) => {
            stages.push(s);
          },
          builder: {
            ...t.doors.builder,
            readTransaction: async (i: { transaction: string }) => {
              const read = (await honest(i))!;
              if (!i.transaction.endsWith('+coins')) return read;
              const changed = handedBack({ contract: VAULT, commitment: outputOf(t.w.built[0]!) });
              return changed === null ? null : { ...read, ...changed };
            }
          }
        },
        VAULT,
        MONEY
      ).catch((x: unknown) => x);
      /* RED WHEN: a wallet that hands back another coin, another vault, a second copy or other calls has it sent all the same. */
      expect(e, why).toBeInstanceOf(DepositNotAsBuilt);
      /* RED WHEN: the screen reads it as a deposit that may have been sent. */
      expect(e, why).toBeInstanceOf(DepositNotSent);
      expect((e as Error).message, why).toMatch(
        /^the deposit was not sent, so no money moved \(your wallet handed back a deposit other than the one this device built: /
      );
      expect(t.w.sent, why).toEqual([]);
      expect(stages, why).not.toContain('sending the deposit');
      /* RED WHEN: a deposit that was never sent stays kept on its way here, and stops the next one. */
      expect(t.kept.size, why).toBe(0);
      expect((await t.pool.load(VAULT)).notes, why).toEqual([]);
      /* The next deposit, handed back as built, is sent. */
      const next = await depositIntoCompanyVault(
        {
          ...t.doors,
          pay: async (ask) => {
            t.lands(t.w.built[t.w.built.length - 1]!);
            return { transaction: `${ask.transaction}+coins`, leaves: [] };
          }
        },
        VAULT,
        { ...MONEY, value: MONEY.value + 1n }
      );
      expect(next.note.value, why).toBe(MONEY.value + 1n);
      expect(t.w.sent, why).toHaveLength(1);
    });
  }

  it("A DEPOSIT ON ITS WAY IS FOUND BY WHAT THIS DEVICE READ AT THE WALLET'S INDEXER, BY ITS NAME OR BY ITS OUTPUT; THE SERVICE IS NEVER ASKED", async () => {
    for (const named of [HASH, null]) {
      const t = await setUp();
      t.w.depositAnswer = { txRef: 'p', transactionHash: named };
      const asked: string[] = [];
      const doors = { ...t.doors, service: aServiceThatLies(t.doors.service, asked) };
      await depositIntoCompanyVault(doors, VAULT, MONEY).catch(() => undefined);
      t.lands(t.w.built[0]!);
      const reads = [t.w.eventReads, t.w.lookups];
      expect(await settleDepositInFlight(doors, VAULT), String(named)).toMatchObject({
        state: 'recorded',
        note: { createdIn: HASH }
      });
      /* RED WHEN: the transaction a deposit landed in is asked of the service, by its name or by its output. */
      expect(asked, String(named)).toEqual([]);
      /* RED WHEN: the deposit is recorded without the chain being read here - by name when the send named one, else by its output. */
      expect([t.w.eventReads - reads[0]! > 0, t.w.lookups - reads[1]! > 0], String(named)).toEqual(
        named === null ? [false, true] : [true, false]
      );
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
    expect((await kept.coins(VAULT)).map((c) => c.nonce)).toEqual([
      (settled as { note: { nonce: string } }).note.nonce
    ]);
    expect(t.kept.size).toBe(0);
  });

  it('A DEPOSIT THE WALLET FINISHED AND THE SERVICE REFUSED TO SEND SAYS NO MONEY MOVED, AND LEAVES NOTHING IN FLIGHT', async () => {
    const t = await setUp();
    t.w.sendFails = Object.assign(new Error('the fee payer would not take it'), { nothingWasSent: true });
    const e = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    /* RED WHEN: a refused send is reported as a deposit that may still land, or the page stops saying the wallet may hold coins. */
    expect(e).toBeInstanceOf(DepositNotSent);
    expect((e as Error).message).toMatch(/no money moved.*wallet may show part of its balance as held/);
    expect(
      t.kept.size,
      'RED WHEN: a deposit that was never sent is kept in flight, so the next one is refused for nothing'
    ).toBe(0);
    const failing = await setUp();
    const walletSaidNo = await depositIntoCompanyVault(
      {
        ...failing.doors,
        pay: async () => {
          throw new Error('the person closed the wallet');
        }
      },
      VAULT,
      MONEY
    ).catch((x) => x);
    expect((walletSaidNo as Error).message).toMatch(/closed the wallet/);
    expect(failing.kept.size, 'RED WHEN: a deposit the wallet never finished is kept in flight').toBe(0);
  });

  it('A SEND THAT MAY HAVE LANDED IS KEPT IN FLIGHT, BEFORE THE WALLET IS ASKED, AND SAYS THE MONEY MAY HAVE MOVED', async () => {
    const t = await setUp();
    let keptBeforeTheWallet = false;
    t.w.sendFails = new Error('the connection dropped');
    const e = await depositIntoCompanyVault(
      {
        ...t.doors,
        pay: async (ask) => {
          keptBeforeTheWallet = t.kept.size === 1;
          return { transaction: `${ask.transaction}+coins`, leaves: [] };
        }
      },
      VAULT,
      MONEY
    ).catch((x) => x);
    expect(e).toBeInstanceOf(DepositNotYetSeen);
    expect((e as Error).message).toMatch(/^the deposit may have been sent/);
    expect(
      keptBeforeTheWallet,
      'RED WHEN: the record of the deposit is written after the wallet is asked, so a closed page loses it'
    ).toBe(true);
    expect(
      [...t.kept.values()].map((d) => d.coin),
      'RED WHEN: a send that may have landed is forgotten'
    ).toEqual([t.w.built[0]]);
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
      const b = {
        ...t.b,
        vaultOnChain: async (i: Parameters<VaultBuilderClient['vaultOnChain']>[0]) =>
          ({ ...(await t.b.vaultOnChain(i)), account }) as never
      };
      /* RED WHEN: the account the vault is pinned to is not compared with the company's - its money would be paid out on somebody else's approvals. */
      await expect(depositIntoCompanyVault({ ...t.doors, builder: b }, VAULT, MONEY)).rejects.toThrow(
        /not pinned to your company's account, or its state is not a vault's/
      );
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
      }
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
      service: {
        ...t.service,
        chain: async () =>
          view({
            heldByCommittee: true,
            started: true,
            state: 'AAAA',
            notes: [heldOf(coin)],
            everCreated: [outputOf(coin)]
          })
      }
    };
    /* RED WHEN: settling believes the service's notes - a deposit the chain does not hold is recorded as the vault's. */
    await expect(settleDepositInFlight(lying, VAULT)).rejects.toBeInstanceOf(DepositStillInFlight);
    expect((await t.pool.load(VAULT)).notes).toEqual([]);
  });

  it('A WALLET THAT NAMES NO INDEXER, OR A READ THAT FAILS ON THIS DEVICE: REFUSED BY NAME, NOTHING CHOSEN, KEPT OR SENT, AND THE SERVICE NOT ASKED IN ITS PLACE', async () => {
    const t = await setUp();
    const asked = { n: 0 };
    const e = await depositIntoCompanyVault(
      { ...theServiceNeverAsked(t.doors, asked), indexer: async () => null },
      VAULT,
      MONEY
    ).catch((x) => x);
    /* RED WHEN: a wallet that names no indexer falls back to the service's answer, or the refusal does not say what resolves it. */
    expect(e).toBeInstanceOf(VaultNotReadHere);
    expect((e as Error).message).toMatch(
      /^your wallet did not say which indexer .* Unlock your wallet for this company again, then try again\. The company's service is not asked in its place\. Nothing was sent\.$/
    );
    const unread = await depositIntoCompanyVault(
      {
        ...theServiceNeverAsked(t.doors, asked),
        builder: {
          ...t.b,
          vaultOnChain: async () => {
            throw new Error('the indexer did not answer');
          }
        }
      },
      VAULT,
      MONEY
    ).catch((x) => x);
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
    expect(
      notes.find((n) => n.nonce === firstCoin.nonce),
      'RED WHEN: the earlier deposit is not recorded once it lands'
    ).toMatchObject({ nonce: firstCoin.nonce, value: 7n, createdIn: HASH });
    expect(second, 'the second deposit then goes ahead, and is itself not yet seen').toBeInstanceOf(DepositNotYetSeen);
    expect(t.w.built, 'RED WHEN: the second deposit is not built').toHaveLength(2);
    expect(
      t.w.built[1]!.nonce,
      'RED WHEN: the second deposit of the same money is built from the coin the first one made'
    ).not.toBe(firstCoin.nonce);
    /* The pool holds exactly what the chain holds of these deposits. */
    expect(notes.map((n) => heldOf({ nonce: n.nonce, token: n.token, value: n.value.toString() })).sort()).toEqual(
      [...t.w.notes].sort()
    );
  });

  it("AN EARLIER DEPOSIT THAT HAS LANDED IS RECORDED EVEN WHEN THIS ONE IS REFUSED FOR THE CHAIN'S LEDGER VERSION", async () => {
    const t = await setUp();
    const first = await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch((x) => x);
    expect(first).toBeInstanceOf(DepositNotYetSeen);
    const firstCoin = t.w.built[0]!;
    t.lands(firstCoin);
    const otherVersion = btoa('midnight:ledger-parameters[v9]:stand-in');
    const builder = {
      ...t.doors.builder,
      chainAtOneBlock: async () => ({
        blockHash: 'B1',
        vaultState: 'V',
        zswapState: 'Z',
        parameters: otherVersion,
        accountState: 'A'
      })
    };
    const second = await depositIntoCompanyVault({ ...t.doors, builder }, VAULT, MONEY).catch((x) => x);
    expect((second as Error).message).toMatch(/different ledger version/);
    /* RED WHEN: the ledger version is checked before the earlier deposit is settled, so a landed note waits for a page update. */
    expect(
      (await t.pool.load(VAULT)).notes.find((n) => n.nonce === firstCoin.nonce),
      'the landed deposit was not recorded'
    ).toMatchObject({ nonce: firstCoin.nonce, value: 7n, createdIn: HASH });
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
    await expect(
      settleDepositInFlight(t.doors, VAULT),
      'RED WHEN: a deposit is let go before it can no longer land'
    ).rejects.toBeInstanceOf(DepositStillInFlight);
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
    expect((await apart.pool.load(VAULT)).notes, "RED WHEN: a note the vault's notes do not hold is recorded").toEqual(
      []
    );
    expect(
      apart.kept.size,
      'RED WHEN: a deposit the chain made is forgotten before it is recorded, however long ago it was sent'
    ).toBe(1);
    apart.w.notes.push(heldOf(apart.w.built[0]!));
    apart.w.events.set(HASH, [
      {
        transactionHash: HASH,
        details: { tag: 'zswapOutput', commitment: outputOf(apart.w.built[0]!), contract: VAULT, mtIndex: '4' }
      }
    ]);
    expect(await settleDepositInFlight(apart.doors, VAULT)).toMatchObject({
      state: 'recorded',
      note: { createdIn: HASH }
    });

    /* The vault holds it and the transaction the service named shows some other coin: the note is recorded, with no transaction. */
    const other = await setUp();
    await depositIntoCompanyVault(other.doors, VAULT, MONEY).catch(() => undefined);
    other.w.notes.push(heldOf(other.w.built[0]!));
    other.w.events.set(HASH, [
      {
        transactionHash: HASH,
        details: { tag: 'zswapOutput', commitment: 'ff'.repeat(32), contract: VAULT, mtIndex: '1' }
      }
    ]);
    const settled = await settleDepositInFlight(other.doors, VAULT);
    expect(settled.state).toBe('recorded');
    const [note] = (await other.pool.load(VAULT)).notes;
    expect(
      note?.createdIn,
      'RED WHEN: a transaction whose events do not show the note is recorded as its creator'
    ).toBeUndefined();
    expect(
      (settled as { notYetSpendable?: string }).notYetSpendable,
      'RED WHEN: a note that cannot be paid out yet is recorded silently'
    ).toMatch(/does not show this deposit/);

    /* The service could not name the transaction and the vault's history does not list one yet: nothing is recorded, and it is kept. */
    const nameless = await setUp();
    nameless.w.depositAnswer = { txRef: 'p', transactionHash: null };
    const waited = await depositIntoCompanyVault(
      {
        ...nameless.doors,
        pay: async (ask) => {
          nameless.w.notes.push(heldOf(nameless.w.built[0]!));
          return { transaction: `${ask.transaction}+coins`, leaves: [] };
        }
      },
      VAULT,
      MONEY
    ).catch((x) => x);
    expect(waited, 'RED WHEN: a note is recorded under a transaction nothing established').toBeInstanceOf(
      DepositLandedNotYetRecorded
    );
    expect((await nameless.pool.load(VAULT)).notes).toEqual([]);
    expect(nameless.kept.size).toBe(1);
  });

  it('A DEPOSIT WHOSE SEND GAVE NO HASH IS RECORDED UNDER ITS CREATING TRANSACTION ONCE IT LANDS, FOUND BY ITS OWN OUTPUT', async () => {
    const LANDED_IN = 'e7'.repeat(32);
    /* The service answered without a hash, and the vault's history lists the transaction by the time the note shows. */
    const nameless = await setUp();
    nameless.w.depositAnswer = { txRef: 'p', transactionHash: null };
    const done = await depositIntoCompanyVault(
      {
        ...nameless.doors,
        pay: async (ask) => {
          nameless.lands(nameless.w.built[0]!, LANDED_IN);
          return { transaction: `${ask.transaction}+coins`, leaves: [] };
        }
      },
      VAULT,
      MONEY
    );
    /* RED WHEN: the page stops looking the transaction up by the deposit's output - the note is then recorded with none. */
    expect(
      done.note.createdIn,
      'RED WHEN: a deposit with no hash from its send is recorded without its creating transaction'
    ).toBe(LANDED_IN);
    expect(done.notYetSpendable).toBeUndefined();
    expect(nameless.kept.size).toBe(0);

    /* The answer to the send was lost altogether and the page was closed; the next look from this browser records it. */
    const dropped = await setUp();
    dropped.w.sendFails = new Error('the connection dropped');
    await expect(depositIntoCompanyVault(dropped.doors, VAULT, MONEY)).rejects.toBeInstanceOf(DepositNotYetSeen);
    dropped.lands(dropped.w.built[0]!, LANDED_IN);
    const settled = await settleDepositInFlight(dropped.doors, VAULT);
    expect(
      settled,
      'RED WHEN: a deposit whose send outcome was unknown lands and is recorded with no creating transaction'
    ).toMatchObject({ state: 'recorded', note: { createdIn: LANDED_IN } });
    expect((await dropped.pool.load(VAULT)).notes[0]?.createdIn).toBe(LANDED_IN);

    /* Another vault's output under the same commitment is not this deposit's: the vault worker refuses it, so it is not recorded under it. */
    const foreign = await setUp();
    foreign.w.sendFails = new Error('the connection dropped');
    await depositIntoCompanyVault(foreign.doors, VAULT, MONEY).catch(() => undefined);
    const coin = foreign.w.built[0]!;
    foreign.w.notes.push(heldOf(coin));
    foreign.w.everCreated.push(outputOf(coin));
    foreign.w.events.set(LANDED_IN, [
      {
        transactionHash: LANDED_IN,
        details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: VAULT, mtIndex: '4' }
      },
      {
        transactionHash: LANDED_IN,
        details: { tag: 'zswapOutput', commitment: outputOf(coin), contract: 'ee'.repeat(32), mtIndex: '5' }
      }
    ]);
    const refused = await settleDepositInFlight(foreign.doors, VAULT);
    expect(
      (await foreign.pool.load(VAULT)).notes[0]?.createdIn,
      'RED WHEN: the page records a transaction the vault worker did not establish'
    ).toBeUndefined();
    expect((refused as { notYetSpendable?: string }).notYetSpendable).toMatch(/does not show this deposit/);
  });

  it('A DEPOSIT THE VAULT HOLDS WHOSE TRANSACTION CANNOT BE READ YET IS NOT RECORDED UNTIL IT CAN BE, OR UNTIL ITS TIME TO LIVE HAS PASSED', async () => {
    const t = await setUp();
    const e = await depositIntoCompanyVault(
      {
        ...t.doors,
        pay: async (ask) => {
          /* The note lands at once, and the indexer has not got the transaction's events. */
          t.w.notes.push(heldOf(t.w.built[0]!));
          return { transaction: `${ask.transaction}+coins`, leaves: [] };
        }
      },
      VAULT,
      MONEY
    ).catch((x) => x);
    /* RED WHEN: the note is recorded with the service's hash before the chain's events confirm it. */
    expect(e).toBeInstanceOf(DepositLandedNotYetRecorded);
    expect((await t.pool.load(VAULT)).notes).toEqual([]);
    expect(t.kept.size, 'RED WHEN: it is forgotten while its note is unrecorded').toBe(1);
    await expect(settleDepositInFlight(t.doors, VAULT)).rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
    /* Past its time to live, with the events still unreadable: recorded without a transaction, rather than blocking every later deposit. */
    t.later(DEPOSIT_TIME_TO_LIVE_MS + DEPOSIT_CLOCKS_MAY_DIFFER_MS + 1);
    const gaveUp = await settleDepositInFlight(t.doors, VAULT);
    expect(
      gaveUp,
      'RED WHEN: a note the vault holds is kept waiting for ever on a transaction nobody can read'
    ).toMatchObject({ state: 'recorded', notYetSpendable: expect.stringMatching(/could not read the transfer/) });
    expect((await t.pool.load(VAULT)).notes[0]?.createdIn).toBeUndefined();
    expect(t.kept.size).toBe(0);

    /* And when the events do come in time, the note is recorded under its own transaction. */
    const u = await setUp();
    await depositIntoCompanyVault(
      {
        ...u.doors,
        pay: async (ask) => {
          u.w.notes.push(heldOf(u.w.built[0]!));
          return { transaction: `${ask.transaction}+coins`, leaves: [] };
        }
      },
      VAULT,
      MONEY
    ).catch(() => undefined);
    u.w.events.set(HASH, [
      {
        transactionHash: HASH,
        details: { tag: 'zswapOutput', commitment: outputOf(u.w.built[0]!), contract: VAULT, mtIndex: '4' }
      }
    ]);
    expect(await settleDepositInFlight(u.doors, VAULT)).toMatchObject({ state: 'recorded', note: { createdIn: HASH } });
    expect(u.kept.size).toBe(0);
  });

  it('EVENTS THE VAULT WORKER CANNOT JUDGE, OR CANNOT JUDGE YET, LEAVE THE DEPOSIT UNRECORDED UNTIL THEY CAN BE, OR UNTIL ITS TIME TO LIVE HAS PASSED', async () => {
    const judges: Array<VaultBuilderClient['creatingTransaction']> = [
      async () => {
        throw new Error('the part of this page that builds vault transactions stopped');
      },
      async () => ({ state: 'unreadable' })
    ];
    for (const judge of judges) {
      const t = await setUp();
      t.b.creatingTransaction = judge;
      await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
      t.lands(t.w.built[0]!);
      await expect(
        settleDepositInFlight(t.doors, VAULT),
        'RED WHEN: a deposit whose events were not judged is recorded, or reported as never showing it'
      ).rejects.toBeInstanceOf(DepositLandedNotYetRecorded);
      expect((await t.pool.load(VAULT)).notes).toEqual([]);
      expect(t.kept.size).toBe(1);
      t.later(DEPOSIT_TIME_TO_LIVE_MS + DEPOSIT_CLOCKS_MAY_DIFFER_MS + 1);
      expect(
        await settleDepositInFlight(t.doors, VAULT),
        'RED WHEN: an unjudged transaction is given the words of a refused one'
      ).toMatchObject({ state: 'recorded', notYetSpendable: expect.stringMatching(/could not read the transfer/) });
    }
  });

  it("EVENTS SERVED UNDER ANOTHER TRANSACTION'S HASH DO NOT NAME THE DEPOSIT'S", async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    t.lands(t.w.built[0]!);
    t.w.events.set(
      HASH,
      t.w.events.get(HASH)!.map((e) => ({ ...e, transactionHash: 'e2'.repeat(32) }))
    );
    const settled = await settleDepositInFlight(t.doors, VAULT);
    expect(
      (await t.pool.load(VAULT)).notes[0]?.createdIn,
      'RED WHEN: the page names the transaction from the events it was served rather than the one the service named'
    ).toBeUndefined();
    expect((settled as { notYetSpendable?: string }).notYetSpendable).toMatch(/does not show this deposit/);
  });

  it('THE VAULT WORKER NAMES THE CREATING TRANSACTION, REFUSES ONE WHOSE EVENTS DO NOT SHOW THE NOTE, AND CALLS NO EVENTS UNREADABLE', async () => {
    const own = [
      {
        transactionHash: HASH,
        details: { tag: 'zswapOutput', commitment: 'aa'.repeat(32), contract: VAULT, mtIndex: '4' }
      }
    ];
    const ask = (commitment: string, events: typeof own) =>
      answerVaultAsk(async () => ({}) as never, {
        id: 3,
        network: 'undeployed',
        ask: 'creating-transaction',
        vault: VAULT,
        commitment,
        transactionHash: HASH,
        events
      });
    expect(
      await ask('aa'.repeat(32), own),
      'RED WHEN: the worker does not name the transaction its events show'
    ).toEqual({ id: 3, ok: true, ask: 'creating-transaction', answer: { state: 'found', createdIn: HASH } });
    expect(
      ((await ask('bb'.repeat(32), own)) as { answer: unknown }).answer,
      'RED WHEN: events that do not show the note are not a refusal'
    ).toEqual({ state: 'refused' });
    const another = own.map((e) => ({ ...e, transactionHash: 'e2'.repeat(32) }));
    expect(
      ((await ask('aa'.repeat(32), another)) as { answer: unknown }).answer,
      'RED WHEN: events from a transaction other than the one named are taken as its own'
    ).toEqual({ state: 'refused' });
    expect(
      creatingTransactionOfNote({ vault: VAULT, commitment: 'aa'.repeat(32), transactionHash: HASH, events: [] }),
      'RED WHEN: no events at all is judged a refusal, which would record the note as never shown'
    ).toEqual({ state: 'unreadable' });

    /* Through the page's own client, with every answer copied as a message between threads is. */
    const listeners: Array<(event: { data: unknown }) => void> = [];
    const client = vaultBuilderOver(
      {
        postMessage: (m) => {
          void answerVaultAsk(async () => ({}) as never, m as never).then((a) =>
            listeners.forEach((l) => l({ data: structuredClone(a) }))
          );
        },
        addEventListener: (_type, l) => {
          listeners.push(l);
        }
      },
      'undeployed'
    );
    expect(
      await client.creatingTransaction({
        vault: VAULT,
        commitment: 'aa'.repeat(32),
        transactionHash: HASH,
        events: own
      }),
      "RED WHEN: the page's client does not carry the worker's answer back"
    ).toEqual({ state: 'found', createdIn: HASH });
    expect(
      await client.creatingTransaction({
        vault: VAULT,
        commitment: 'bb'.repeat(32),
        transactionHash: HASH,
        events: own
      })
    ).toEqual({ state: 'refused' });
  });

  it('A NOTE ANOTHER SIGNER ALREADY RECORDED IS NOT RECORDED TWICE, AND IS SETTLED WITHOUT ASKING THE CHAIN', async () => {
    const t = await setUp();
    await depositIntoCompanyVault(t.doors, VAULT, MONEY).catch(() => undefined);
    const coin = t.w.built[0]!;
    t.lands(coin);
    const now = await t.pool.load(VAULT);
    await t.pool.save(
      VAULT,
      {
        notes: [...now.notes, { nonce: coin.nonce as never, token: MONEY.token, value: 7n, createdIn: HASH as never }]
      },
      now.readAt
    );
    const reads = t.w.eventReads;
    expect(await settleDepositInFlight(t.doors, VAULT)).toEqual({ state: 'already-recorded' });
    expect(t.w.eventReads, "RED WHEN: a deposit already in the record still waits on the chain's events").toBe(reads);
    expect((await t.pool.load(VAULT)).notes, 'RED WHEN: a note already in the record is added again').toHaveLength(1);
    expect(t.kept.size).toBe(0);
  });
});

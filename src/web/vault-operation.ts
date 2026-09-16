/**
 * **CREATING A COMPANY'S VAULT, OPENING ITS POOL, AND PUTTING MONEY IN IT,
 * FROM A SIGNER'S OWN DEVICE.**
 *
 * Each of the three is one operation a person starts with one press. Everything
 * it touches is handed in, so the same order runs in a test against the ledger's
 * own objects.
 *
 * ── CREATING A VAULT IS ONE OPERATION WITH NO SUCCESS STATE UNTIL THE END ──
 *
 *   1. the company's committee must already be complete: every signer's wallet
 *      has given its committee key. No committee, no deploy;
 *   2. the vault is built here with a temporary key made here, and the key is
 *      kept on this device BEFORE the deploy is sent, so an answer lost on the
 *      way does not lose the key;
 *   3. the deploy is sent;
 *   4. as soon as the chain has the vault, the handover to the committee is
 *      built against the counter the chain reports, signed with the temporary
 *      key, and sent - and sent again, rebuilt, if it does not land;
 *   5. the operation ends when the chain says the committee holds the vault,
 *      and only then. The temporary key is then forgotten.
 *
 * **ANYTHING SHORT OF STEP 5 IS A FAILURE THAT NAMES THE VAULT** (`VaultHandoverOwed`),
 * and running the operation again for that vault picks up at step 4. The
 * service refuses any deposit into the vault until step 5 is true on the chain.
 *
 * ── A DEPOSIT ──
 *
 * The coin is chosen and recorded here (`deposit-on-device.ts`); the call is
 * built and proved here; the person's own wallet adds the coin and signs; the
 * service adds the network fee and sends it. The vault's note pool records the
 * new note only once the chain holds it, with the transaction that made it.
 */
import type { Hex } from '../core/crypto.js';
import type { Committee } from '../midnight/vault-committee.js';
import type { DepositMoney } from '../midnight/deposit-nonce.js';
import { SealedNotePool, isALostPoolRace, type PoolSigner } from '../midnight/vault-pool.js';
import { afterDeposit } from '../midnight/vault-note-deposit.js';
import type { NonceSecretReader } from '../midnight/company-nonce-secret.js';
import {
  depositCoinOnThisDevice, startVaultNonceSecretOnThisDevice,
  type DeviceRecords, type DeviceSigner,
} from './deposit-on-device.js';
import type { SigningKeyOnTheWire, VaultBuilderClient } from './vault-worker-client.js';

/** What the service says the chain holds for one vault. */
export interface VaultChainView {
  readonly vault: Hex;
  readonly onChain: boolean;
  /** Base64 of the vault's contract state. */
  readonly state?: string;
  readonly notes?: readonly Hex[];
  readonly everCreated?: readonly string[];
  readonly authority?: {
    readonly committee: readonly { tag: string; value: string }[];
    readonly threshold: number;
    readonly counter: string;
    readonly shape: string;
  } | null;
  readonly committee?: Committee | null;
  readonly heldByCommittee?: boolean;
  readonly why?: string | null;
}

export interface VaultKeysView {
  readonly committee: Committee | null;
  readonly why: string | null;
  /** Every signer's records key the service holds, this device's included. */
  readonly readers: readonly Hex[];
}

/** The routes in `src/server/company-vaults.ts`, as the page calls them. */
export interface VaultService {
  keys(): Promise<VaultKeysView>;
  deploy(tx: string): Promise<{ vault: Hex; txRef: string }>;
  handover(vault: Hex, tx: string): Promise<{ txRef: string }>;
  chain(vault: Hex): Promise<VaultChainView>;
  deposit(vault: Hex, tx: string): Promise<{ txRef: string; transactionHash: string | null }>;
}

/** Where this device keeps a vault's temporary key until the handover has landed. */
export interface TemporaryKeys {
  put(vault: Hex, key: SigningKeyOnTheWire): Promise<void>;
  get(vault: Hex): Promise<SigningKeyOnTheWire | null>;
  forget(vault: Hex): Promise<void>;
}

export type VaultStage =
  | 'checking the committee' | 'building the vault' | 'sending the vault'
  | 'waiting for the chain' | 'handing the vault to the committee' | 'waiting for the handover'
  | 'opening the pool' | 'choosing the coin' | 'building the deposit'
  | 'asking your wallet' | 'sending the deposit' | 'recording the deposit' | 'done';

export interface Pacing {
  readonly sleep: (ms: number) => Promise<void>;
  /** How long to keep asking the chain for one thing to appear. */
  readonly waitMs?: number;
  readonly everyMs?: number;
  readonly progress?: (stage: VaultStage) => void;
}

/**
 * **THE HANDOVER HAS NOT LANDED.** Names the vault; the service will take no
 * money into it; running `createCompanyVault` again with `resume` finishes it.
 */
export class VaultHandoverOwed extends Error {
  constructor(readonly vault: Hex, why: string) {
    super(`the vault ${vault} was deployed and is not yet held by the company's committee: ${why} `
      + 'No money can be put into it until it is. Try again to finish handing it over.');
    this.name = 'VaultHandoverOwed';
  }
}

const sentNothing = (e: unknown): boolean => (e as { nothingWasSent?: unknown })?.nothingWasSent === true;

async function until<T>(
  pacing: Pacing, ask: () => Promise<T | null>,
): Promise<T | null> {
  const every = pacing.everyMs ?? 6_000;
  const tries = Math.max(1, Math.ceil((pacing.waitMs ?? 10 * 60_000) / every));
  for (let i = 0; i < tries; i += 1) {
    const got = await ask();
    if (got !== null) return got;
    await pacing.sleep(every);
  }
  return null;
}

export interface CreateVaultDoors extends Pacing {
  readonly account: Hex;
  readonly service: VaultService;
  readonly builder: VaultBuilderClient;
  readonly keys: TemporaryKeys;
}

/**
 * **STEPS 1 TO 5.** With `resume`, starts at step 4 for a vault this device
 * deployed and has not yet seen handed over.
 */
export async function createCompanyVault(
  doors: CreateVaultDoors, resume?: Hex,
): Promise<{ vault: Hex; state: 'held-by-committee' }> {
  let vault = resume;
  if (vault === undefined) {
    doors.progress?.('checking the committee');
    const { committee, why } = await doors.service.keys();
    if (committee === null) throw new Error(why ?? 'this company has no committee yet, so no vault is created.');
    doors.progress?.('building the vault');
    const built = await doors.builder.deploy(doors.account);
    await doors.keys.put(built.vault as Hex, built.temporaryKey);
    doors.progress?.('sending the vault');
    try {
      vault = (await doors.service.deploy(built.tx)).vault;
    } catch (e) {
      if (sentNothing(e)) await doors.keys.forget(built.vault as Hex);
      else throw new VaultHandoverOwed(built.vault as Hex, `the deploy may have been sent (${(e as Error)?.message ?? e}).`);
      throw e;
    }
  }
  return finishHandover(doors, vault);
}

async function finishHandover(doors: CreateVaultDoors, vault: Hex): Promise<{ vault: Hex; state: 'held-by-committee' }> {
  const HANDOVER_TRIES = 3;
  for (let attempt = 1; attempt <= HANDOVER_TRIES; attempt += 1) {
    doors.progress?.('waiting for the chain');
    const view = await until(doors, async () => {
      const v = await doors.service.chain(vault);
      return v.onChain ? v : null;
    });
    if (view === null) throw new VaultHandoverOwed(vault, 'the chain has not shown the vault yet.');
    if (view.heldByCommittee === true) {
      await doors.keys.forget(vault);
      doors.progress?.('done');
      return { vault, state: 'held-by-committee' };
    }
    const authority = view.authority;
    if (!authority || authority.shape !== 'one-key' || !view.committee) {
      throw new VaultHandoverOwed(vault, view.why ?? 'the chain shows an authority this device cannot hand over.');
    }
    const key = await doors.keys.get(vault);
    if (key === null) {
      throw new VaultHandoverOwed(vault,
        'the temporary key it was deployed with is not on this device, so only the device that deployed it '
        + 'can hand it over. It holds nothing; if that device is gone, create a new vault.');
    }
    doors.progress?.('handing the vault to the committee');
    const built = await doors.builder.handover({
      vault, counter: BigInt(authority.counter), temporaryKey: key, to: view.committee,
    });
    try {
      await doors.service.handover(vault, built.tx);
    } catch (e) {
      if (!sentNothing(e) || attempt === HANDOVER_TRIES) {
        throw new VaultHandoverOwed(vault, (e as Error)?.message ?? String(e));
      }
      continue;
    }
    doors.progress?.('waiting for the handover');
    const held = await until(doors, async () => ((await doors.service.chain(vault)).heldByCommittee === true ? true : null));
    if (held) {
      await doors.keys.forget(vault);
      doors.progress?.('done');
      return { vault, state: 'held-by-committee' };
    }
  }
  throw new VaultHandoverOwed(vault, 'the handover was sent and the chain has not shown it.');
}

export interface PoolDoors extends Pacing {
  readonly service: VaultService;
  readonly me: DeviceSigner;
  /** This device's own records key, so it is not wrapped to twice. */
  readonly myRecordsKey: Hex;
  readonly signers: () => Promise<readonly PoolSigner[]>;
  readonly records: DeviceRecords;
}

/**
 * **THE VAULT'S NOTE POOL AND NONCE SECRET, FILED THROUGH THE COMPANY'S RECORDS
 * ROUTE.** Only for a vault its committee holds and the chain has never paid
 * into. Each half is skipped when it is already filed, so it can be run again.
 */
export async function openCompanyVaultPool(doors: PoolDoors, vault: Hex): Promise<void> {
  doors.progress?.('opening the pool');
  const view = await doors.service.chain(vault);
  if (!view.onChain || view.heldByCommittee !== true) {
    throw new Error(view.why ?? 'this vault is not held by the company\'s committee yet, so its pool is not opened.');
  }
  const everCreated = new Set(view.everCreated ?? []);
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  if (await doors.records('pool').get(vault) === null) {
    if ((view.notes ?? []).length > 0 || everCreated.size > 0) {
      throw new Error('the chain has already put money in this vault and it has no pool, so a new empty pool '
        + 'would record nothing of it. Nothing is filed; rebuild the pool from the company\'s records instead.');
    }
    await pool.create(vault, { notes: [] });
  }
  if (await doors.records('nonce-secret').get(vault) === null) {
    const { readers } = await doors.service.keys();
    const others: NonceSecretReader[] = readers
      .filter((k) => k.toLowerCase() !== doors.myRecordsKey.toLowerCase())
      .map((publicKey) => ({ publicKey }));
    await startVaultNonceSecretOnThisDevice(vault, doors.me, others, doors.records, everCreated);
  }
  doors.progress?.('done');
}

export interface DepositDoors extends PoolDoors {
  readonly company: Hex;
  readonly builder: VaultBuilderClient;
  readonly pay: (ask: { company: Hex; vault: Hex; transaction: string }) =>
    Promise<{ transaction: string; leaves: readonly unknown[] }>;
}

/** **THE DEPOSIT WAS SENT AND THE CHAIN HAS NOT SHOWN IT.** The money may have moved. */
export class DepositNotYetSeen extends Error {
  constructor(readonly vault: Hex, readonly txRef: string) {
    super(`the deposit was sent (${txRef}) and the chain has not shown it yet, so it may still land. `
      + 'Its note is not recorded in the pool until it does; its journal line already names it, and the '
      + 'company\'s records rebuild it. Do not deposit again until the vault shows it.');
    this.name = 'DepositNotYetSeen';
  }
}

export async function depositIntoCompanyVault(
  doors: DepositDoors, vault: Hex, money: DepositMoney,
): Promise<{ txRef: string; transactionHash: string | null; note: { nonce: Hex; token: Hex; value: bigint } }> {
  const view = await doors.service.chain(vault);
  if (!view.onChain || view.heldByCommittee !== true || view.state === undefined) {
    throw new Error(view.why ?? 'this vault is not held by the company\'s committee, so no money goes in.');
  }
  const notes = new Set((view.notes ?? []).map((n) => n.toLowerCase()));
  const commitments = (coin: { nonce: Hex; token: Hex; value: bigint }) => doors.builder.commitments({
    vault, coin: { nonce: coin.nonce, token: coin.token, value: coin.value.toString() },
  });
  doors.progress?.('choosing the coin');
  const { coin } = await depositCoinOnThisDevice({
    vault, money, me: doors.me, signers: doors.signers, records: doors.records,
    chain: {
      everCreated: new Set(view.everCreated ?? []),
      outputCommitmentOf: async (c) => (await commitments(c)).output,
      heldNow: async (c) => notes.has((await commitments(c)).held.toLowerCase()),
    },
  });
  doors.progress?.('building the deposit');
  const built = await doors.builder.deposit({
    vault, coin: { nonce: coin.nonce, token: coin.token, value: coin.value.toString() }, state: view.state,
  });
  doors.progress?.('asking your wallet');
  const paid = await doors.pay({ company: doors.company, vault, transaction: built.tx });
  doors.progress?.('sending the deposit');
  const sent = await doors.service.deposit(vault, paid.transaction);
  doors.progress?.('recording the deposit');
  const held = (await commitments(coin)).held.toLowerCase();
  const seen = await until(doors, async () => {
    const v = await doors.service.chain(vault);
    return (v.notes ?? []).some((n) => n.toLowerCase() === held) ? true : null;
  });
  if (!seen) throw new DepositNotYetSeen(vault, sent.txRef);
  const pool = new SealedNotePool(doors.records('pool'),
    { signerId: doors.me.signerId, wrappingSecret: doors.me.wrappingSecret }, doors.signers);
  const note = {
    nonce: coin.nonce, token: coin.token, value: coin.value,
    ...(sent.transactionHash === null ? {} : { createdIn: sent.transactionHash as Hex }),
  };
  const ATTEMPTS = 5;
  for (let attempt = 1; ; attempt += 1) {
    const now = await pool.load(vault);
    try {
      await pool.save(vault, { notes: afterDeposit(now, note).notes }, now.readAt);
      break;
    } catch (cause) {
      if (!isALostPoolRace(cause) || attempt === ATTEMPTS) throw cause;
    }
  }
  doors.progress?.('done');
  return { txRef: sent.txRef, transactionHash: sent.transactionHash, note };
}

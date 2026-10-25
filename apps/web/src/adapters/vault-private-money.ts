import { privateAmount, type PrivateAmount } from 'vaults-ui';
import { assets, type AssetRegistry } from '../../../../src/core/assets.js';
import type { SealedAccount } from '../../../../src/core/types.js';
import type { Hex } from '../../../../src/core/crypto.js';
import { SealedNotePool } from '../../../../src/midnight/vault-pool.js';
import { deviceVaultHoldings } from 'vaults-web-shared/device-vault-holdings.js';
import { FilingNotBelieved } from 'vaults-web-shared/http-sealed-pool-store.js';
import { api, companyKeyReleasedFor, currentUser, holdersFromTheWallet, seatShownHere, watchCompanyKeyReleased, type OpenedAccount } from 'vaults-web-shared/keyring.js';
import { browserInFlightRecords, deviceSignerFrom, readersIn, recordsReadHere, type DirectoryRead } from 'vaults-web-shared/vault-page-doors.js';
import type { DeviceRecords, DeviceSigner } from 'vaults-web-shared/deposit-on-device.js';
import type { VaultBuilderClient } from 'vaults-web-shared/vault-worker-client.js';
import { vaultNotesHere, wireOf } from 'vaults-web-shared/vault-operation.js';
import { coinsKeptOnThisDevice } from 'vaults-web-shared/vault-coins-kept-here.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { Fault, FAULT } from '../faults.js';
import { ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { companyRoute } from './handover-state.js';
import { keyringFor } from './keyring-person.js';
import { companyKeysFor, directoryHereFor, filingJudgeFor, openedHere, walletIndexerFor } from './filing-judge.js';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { theVaultBuilder } from './vault-builder.js';

/*
 * WHAT A VAULT HOLDS PRIVATELY, READ ON THIS DEVICE, HANDED TO A SCREEN AS
 * AMOUNTS.
 *
 * A vault's private money is its notes, and the record of them is sealed so
 * that only a signer's own key opens it; so it is read here or nowhere. The
 * reader is the one the payments page uses
 * (`deviceVaultHoldings`), given the same doors: the vault's pool opened with
 * the records key this signer's wallet released for the company, filed under
 * their seat, the seats the company's directory names as the ones the pool is
 * wrapped to, the vault's notes read off the chain in the page's vault worker
 * at the indexer the person's own wallet names, and each note's commitment
 * worked out in the same worker. The pool is believed only when a seat the company's
 * directory names filed it, checked against a fresh read by the person's own
 * wallet. Every read first rebuilds the vault's notes (`vaultNotesHere`): a
 * note the chain holds that the vault's journals, the chain's split journal or
 * the coins this device keeps name is counted; a note nothing names is not
 * counted. The read files nothing and signs nothing: what it finds owed (a
 * rebuilt pool, a record not yet sealed to a new signer) is filed by a seat
 * action in a signer's wallet. The notes are summed only when the pool and the
 * chain agree both ways. Nothing it reads leaves this device; the vault's
 * address goes out to ask the chain.
 * The signer's seat, keys and records come from `seatAndRecordsHere`: the
 * seat's public half and records that refuse to file, never the seat's secrets.
 * "Check my last deposit" reads through it too; a private deposit is made whole
 * in the person's wallet.
 *
 * The read says which of four things it found, and a screen says each in its
 * own words: the amounts held, nothing held yet (the vault's pool was never
 * opened and the chain holds no note for it), a record that was not believed
 * (no seat of the company signed it, or the chain does not agree with it), or
 * that it could not be read, with which of a few reasons. A reason is told by
 * the kind of failure, never by the reader's words.
 *
 * Each amount is made with `privateAmount`, from the decimals and symbol of the
 * asset whose private token it is, so a screen never holds a number it could
 * show as money. None of the reader's words are handed on. The read never asks
 * the wallet to release the company key: with none released in this tab it
 * says so.
 */

/** The pool's record, and the form private money takes on the ledger: the shared code's names, passed and never shown. */
const LEDGER = { pool: 'pool', shielded: 'shielded', theNewest: 'the-newest' } as const;

/** Which of the four things a read of a vault's private money found. */
export const PRIVATE_MONEY = { held: 'held', nothingYet: 'nothing-yet', notBelieved: 'not-believed', unreadable: 'unreadable' } as const;

/** Why a vault's private money could not be read: no company key released in this tab, the wallet did not answer the ask of who holds the company, the chain or the indexer could not be reached, the chain's ledger is not the shape this build reads, this device has no record of notes the chain holds, or something else stopped the read. */
export const COULD_NOT_READ = {
  noKeys: 'no-keys', walletRefused: 'wallet-refused', chain: 'chain', layout: 'layout', record: 'record', other: 'other',
} as const;
type CouldNotRead = (typeof COULD_NOT_READ)[keyof typeof COULD_NOT_READ];

/**
 * What a read of a vault's private money found, as a screen shows it. When held: one amount for each token the
 * registry names that the vault holds any of, in the registry's order, and how many other tokens it holds a note
 * of, counted and never shown as a figure because with no registry record there are no decimals to write one with.
 */
export type VaultPrivateMoney =
  | { readonly of: typeof PRIVATE_MONEY.held; readonly amounts: readonly PrivateAmount[]; readonly unrecognised: number }
  | { readonly of: typeof PRIVATE_MONEY.nothingYet }
  | { readonly of: typeof PRIVATE_MONEY.notBelieved }
  | { readonly of: typeof PRIVATE_MONEY.unreadable; readonly why: CouldNotRead };

const unreadable = (why: CouldNotRead): VaultPrivateMoney => ({ of: PRIVATE_MONEY.unreadable, why });

/** The refusals that mean the person's wallet was asked and did not answer: declined, closed, out of time or silent. */
const WALLET_DID_NOT_ANSWER: ReadonlySet<ActRefusal> = new Set([
  ACT_REFUSAL.declined, ACT_REFUSAL.expired, ACT_REFUSAL.ranOut, ACT_REFUSAL.unreadable, ACT_REFUSAL.noWindow,
  ACT_REFUSAL.windowGone, ACT_REFUSAL.gaveUp, ACT_REFUSAL.silent,
]);

/** What a failure the read ran into means for the screen, told by its kind: a record no seat signed, a wallet that did not answer, or something else. */
function readFailed(e: unknown): VaultPrivateMoney {
  if (e instanceof FilingNotBelieved) return { of: PRIVATE_MONEY.notBelieved };
  return unreadable(WALLET_DID_NOT_ANSWER.has(refusalOf(e)) ? COULD_NOT_READ.walletRefused : COULD_NOT_READ.other);
}

/**
 * WHAT A SIGNER'S SEAT ON THIS DEVICE GIVES A READ OF A VAULT'S PRIVATE MONEY:
 * the company as the service hands it and as it opened here, the vault worker,
 * the company key this tab's wallet released, this signer's seat as the
 * company's believed directory names it for the seat's signing public key, and
 * the records key that wraps their copy of a vault's records, the company's
 * directory, the seats it names as the ones a vault's records are wrapped to,
 * and the records believed only when a seat the directory names filed them.
 * Nothing here is a seat's secret, and the records refuse to file: a read signs
 * nothing, and a private deposit is made whole in the person's wallet.
 */
export interface SeatAndRecordsHere {
  readonly sealed: SealedAccount;
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  /** The company's account as this device opened it, the signers it believes among them. */
  readonly opened: OpenedAccount;
  readonly builder: VaultBuilderClient;
  readonly companyKey: Hex;
  /** This signer's seat and the records key their copies are wrapped to. */
  readonly mine: DeviceSigner;
  readonly directory: DirectoryRead;
  readonly readers: ReturnType<typeof readersIn>;
  readonly records: DeviceRecords;
}

/**
 * THE SEAT, KEYS AND RECORDS A READ OF THE PERSON `personId` FOR THE COMPANY
 * `companyId` USES ON THIS DEVICE, or why not: nobody or somebody else is
 * signed in, this device holds no keys for the company, the company did not
 * open here or has no account on the chain, or the believed directory names no
 * seat for this signer's public key. Without a company key released in this tab
 * it refuses, unless `release` is given: then the wallet is asked to release
 * it, once, and a refusal there is thrown as the wallet's own. A read of a
 * vault's money passes no `release`, so it asks the wallet for nothing.
 */
export async function seatAndRecordsHere(
  personId: string, companyId: string, release?: () => Promise<unknown>,
): Promise<SeatAndRecordsHere | ActRefusal> {
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  const sealed = await api(companyRoute(companyId)) as SealedAccount;
  const shown = await seatShownHere(companyId);
  if (shown === null) return ACT_REFUSAL.noKeysHere;
  const opened = await openedHere(sealed);
  if (opened === null) return ACT_REFUSAL.didNotFinish;
  const builder = await theVaultBuilder();
  const company = (sealed.companyLabel ?? null) as CompanyLabel | null;
  const account = (sealed.contractAddress ?? null) as AccountAddress | null;
  if (company === null || account === null) return ACT_REFUSAL.didNotFinish;
  /* The company key this tab's wallet already released, or released now when the caller may ask for it. */
  if (companyKeyReleasedFor(companyId) === null && release !== undefined) await release();
  const companyKey = companyKeyReleasedFor(companyId);
  if (companyKey === null) return ACT_REFUSAL.noKeysHere;
  /* Believed only when a seat the directory names filed it, checked against a fresh read by this person's own wallet. */
  const viewingKey = await companyKeysFor(companyId, sealed, shown);
  const judge = filingJudgeFor(companyId, company, account, viewingKey, async () => opened);
  const directory = directoryHereFor(companyId, company, account, viewingKey, async () => opened);
  /* This signer's seat: the one the directory names for their public key, the only seat a vault's records are wrapped to them under. */
  let here: Awaited<ReturnType<DirectoryRead>>;
  try {
    here = await directory();
  } catch (e) {
    const why = refusalOf(e);
    return WALLET_DID_NOT_ANSWER.has(why) ? why : ACT_REFUSAL.unreachable;
  }
  const own = here.dir.seats.find((x) => x.signingKey.toLowerCase() === shown.signingPublicKey);
  if (own === undefined) return ACT_REFUSAL.noSeat;
  const mine = deviceSignerFrom(own.seat, companyKey);
  const readers = readersIn(directory);
  const records = recordsReadHere(judge, () => currentUser()?.id ?? null);
  return { sealed, company, account, opened, builder, companyKey, mine, directory, readers, records };
}

/**
 * Calls `readable` each time the person's wallet releases `companyId`'s key to this tab, by any press that asks for it
 * (Check my last deposit among them): what a vault of the company holds privately can then be read, where before it
 * could not for want of that key. The answer stops it.
 */
export const watchPrivateMoneyReadable = (companyId: string, readable: () => void): (() => void) =>
  watchCompanyKeyReleased((accountId) => { if (accountId === companyId) readable(); });

/**
 * WHAT THE VAULT `vault` OF THE COMPANY `companyId` HOLDS PRIVATELY, for the
 * person `personId`, and which of four things the read found: the amounts
 * held; nothing held yet, when the vault's pool was never opened and the chain
 * holds no note for it; a record not believed, when no seat of the company
 * signed the pool or the chain contradicts it; or that it could not be read,
 * with why (no keys in this tab, the wallet did not answer, the chain could
 * not be asked, the chain's ledger is not the shape this build reads, no
 * record of notes the chain holds, or anything else). What could not be read
 * is never shown as nothing held. A token it holds none of is not listed, and
 * a token the registry does not name is counted.
 */
export async function readVaultPrivateMoney(
  personId: string, companyId: string, vault: string, registry: AssetRegistry = assets,
): Promise<VaultPrivateMoney> {
  try {
    const here = await seatAndRecordsHere(personId, companyId);
    if (typeof here === 'string') {
      return unreadable(here === ACT_REFUSAL.noKeysHere ? COULD_NOT_READ.noKeys
        : WALLET_DID_NOT_ANSWER.has(here) ? COULD_NOT_READ.walletRefused
        : here === ACT_REFUSAL.unreachable ? COULD_NOT_READ.chain : COULD_NOT_READ.other);
    }
    const { builder, company: label, account: address, mine, readers, records } = here;
    const poolStore = records(LEDGER.pool);
    const pool = new SealedNotePool(poolStore, { signerId: mine.signerId, wrappingSecret: mine.wrappingSecret }, readers.signers);
    const holdings = deviceVaultHoldings({
      /* The vault's notes as the chain holds them, read in this device's vault worker at the indexer this person's own wallet names. */
      chain: async (v) => {
        const indexer = await walletIndexerFor(label, address);
        /* A wallet that names no indexer has the vault read nowhere: the reader answers that the chain was not read. */
        return indexer === null ? { onChain: false } : builder.vaultOnChain({ vault: v, indexer });
      },
      /* The pool opened with this signer's key, or null when the company's records hold none for the vault: a pool that is filed and cannot be opened or is not believed throws, and is never null. */
      pool: async (v) => ((await poolStore.get(v)) === null ? null : (await pool.load(v)).notes),
      heldCommitmentOf: async (v, note) => (await builder.commitments({ vault: v, coin: wireOf(note) })).held,
      /*
       * The vault's notes rebuilt on this device before they are summed: a pool a seat that left filed past its boundary,
       * which the chain vouches for, filed again under this signer's own seat; every note the chain holds that the
       * journals, the chain's split journal or the coins this device keeps name, filed where this seat may file and
       * counted either way; the vault read at the indexer and through the holders this person's own wallet names.
       */
      fileAgain: async (v) => {
        const rebuilt = await vaultNotesHere({
          account: address, builder, me: mine, records, signers: readers.signers,
          /* No seat is given: the read files nothing, and what it finds owed is filed by a seat action in the wallet. */
          indexer: () => walletIndexerFor(label, address),
          onChain: async () => ({
            holders: (await holdersFromTheWallet(ACCOUNT_ORIGIN, { company: label, account: address })).holders,
          }),
          /* The coins this device keeps, in this browser's own storage; a browser with none keeps nothing and the rest still reads. */
          ...((globalThis as { indexedDB?: IDBFactory }).indexedDB === undefined ? {} : {
            kept: coinsKeptOnThisDevice(browserInFlightRecords(), { signerId: mine.signerId, wrappingSecret: mine.wrappingSecret }),
          }),
        }, v);
        return { answer: LEDGER.theNewest, said: rebuilt.leaver ?? [], ...(rebuilt.of === 'not-read' ? {} : { notes: rebuilt.notes }) };
      },
      /* Only what the vault holds is read here; whether payments fit is asked where a payment is made. */
      paymentsFit: () => { throw new Fault(FAULT.vaultPaymentsNotAsked); },
    });
    const tokens: string[] = [];
    const assetsOf = registry.all().filter((asset) => typeof asset.ledger.shielded === 'string');
    for (const asset of assetsOf) tokens.push(asset.ledger.shielded as string);
    if (new Set(tokens.map((t) => t.toLowerCase())).size !== tokens.length) return unreadable(COULD_NOT_READ.other);
    const found = await holdings.privateNotes(vault, tokens);
    switch (found.of) {
      case 'nothing-yet': return { of: PRIVATE_MONEY.nothingYet };
      case 'contradicted': return { of: PRIVATE_MONEY.notBelieved };
      case 'unreadable': {
        if (found.because === 'layout') return unreadable(COULD_NOT_READ.layout);
        if (found.because === 'record') return unreadable(COULD_NOT_READ.record);
        const failed = found.cause === undefined ? null : readFailed(found.cause);
        return failed !== null && failed.of !== PRIVATE_MONEY.unreadable ? failed
          : failed !== null && failed.why !== COULD_NOT_READ.other ? failed : unreadable(COULD_NOT_READ.chain);
      }
      default: {
        const amounts: PrivateAmount[] = [];
        assetsOf.forEach((asset, at) => {
          const amount = found.amounts[at]!;
          if (amount > 0n) amounts.push(privateAmount(amount, asset.decimals, asset.symbol));
        });
        return { of: PRIVATE_MONEY.held, amounts, unrecognised: found.unrecognised };
      }
    }
  } catch (e) {
    return readFailed(e);
  }
}

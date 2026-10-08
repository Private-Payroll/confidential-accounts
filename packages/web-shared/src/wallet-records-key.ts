/**
 * **ASKING THE SIGNED-IN PERSON'S OWN WALLET TO SIGN THEIR RECORDS KEY FOR THE
 * SEAT THEY HOLD, AND TO SAY WHO HOLDS THE COMPANY'S ACCOUNT NOW.**
 *
 * Asked right before a vault's secret is approved. The page names the company,
 * the account that carries it and this person's seat on it; the wallet reads
 * the account off the chain itself, refuses a seat the account does not hold
 * now, and on the person's press hands back the signed statement and the
 * committee and seats it read. No key crosses.
 *
 * When a vault's secret is about to be approved the page names that vault too,
 * and the wallet reads who holds it and which account it is pinned to, off the
 * chain itself; an answer that does not carry that read is refused.
 *
 * Every expectation the answer is checked against is this page's own: where it
 * is, the nonce it chose, the company, the account, the seat and the vault it
 * asked about.
 */
import { REQUEST_SCHEMA, type InvitedBy } from 'midnight-identity/profile/request';
import {
  readHoldersAnswer, readRecordsKeyAnswer, type AccountHoldersRead, type AccountPaymentFacts, type AccountSeats, type DirectoryEntryStatement,
  type RecordsKeyStatement, type VaultHolders,
} from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
import type { WalletIndexer } from 'midnight-identity/profile/unlock';
import { readAddressesAndBalancesAnswer, type AddressesAndBalancesShown } from 'midnight-identity/profile/addresses-and-balances';
import { toHex, randomBytes } from '../../../src/core/crypto.js';
import { askWallet, type Openable, type WalletDialog } from './wallet-sign-in.js';

/** How long the wallet has to answer. */
const RECORDS_KEY_WINDOW_MS = 10 * 60_000;

const RECORDS_KEY_PURPOSE =
  'So the other signers\' devices can check that the copy of a vault\'s secret kept for you is one your own recovery '
  + 'words open. Your wallet signs your records key for your seat, and says who holds your company now.';

class WalletDidNotSignRecordsKey extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WalletDidNotSignRecordsKey';
  }
}

export interface RecordsKeyAsked {
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  /** This person's seat on the account, 64 lower-case hex characters. */
  readonly seat: string;
  /** The vault whose secret is about to be approved, when there is one: the wallet reads who holds it. */
  readonly vault?: VaultAddress;
  /** This person's filing key, when their directory entry is to be signed in the same press. */
  readonly signingKey?: string;
  /**
   * The invitation this person joined by - the inviting signer's committee key
   * and the entry their wallet signed, from the signed invitation - for a
   * wallet that has not kept this company's account yet. It keeps the account
   * that invitation names, and signs for no other; with neither, it signs
   * nothing.
   */
  readonly invitedBy?: InvitedBy;
  readonly atOrigin: string;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
  readonly nonce?: string;
}

/** The ask on the wire. */
const recordsKeyAsk = (parts: {
  name: string; rdns: string; purpose: string; nonce: string; expiresAt: number;
  company: CompanyLabel; account: AccountAddress; seat: string; vault?: VaultAddress; signingKey?: string; invitedBy?: InvitedBy;
}) => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: 'records-key' as const,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: parts.purpose,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
  company: parts.company,
  account: parts.account,
  seat: parts.seat.toLowerCase(),
  ...(parts.vault === undefined ? {} : { vault: parts.vault.toLowerCase() }),
  ...(parts.signingKey === undefined ? {} : { signingKey: parts.signingKey.toLowerCase() }),
  ...(parts.invitedBy === undefined ? {} : { invitedBy: parts.invitedBy }),
});

/** What comes back, checked: the statement, the committee key it verifies against, and who holds the account. */
export interface RecordsKeySigned {
  readonly committeeKey: { readonly tag: string; readonly value: string };
  readonly statement: RecordsKeyStatement;
  readonly seats: AccountSeats;
  /** Who holds the vault asked about, as the wallet read it; null when no vault was asked about. */
  readonly vault: VaultHolders | null;
  /** This person's directory entry, signed in the same press; null when no filing key was named. */
  readonly entry: DirectoryEntryStatement | null;
}

export async function askWalletToSignRecordsKey(
  view: Openable, walletOrigin: string, ask: RecordsKeyAsked, dialog?: WalletDialog,
): Promise<RecordsKeySigned> {
  const now = ask.now ?? (() => Date.now());
  const nonce = ask.nonce ?? toHex(randomBytes(16));
  const answer = await askWallet(view, walletOrigin, recordsKeyAsk({
    name: ask.name, rdns: ask.rdns, purpose: RECORDS_KEY_PURPOSE, nonce, expiresAt: now() + RECORDS_KEY_WINDOW_MS,
    company: ask.company, account: ask.account, seat: ask.seat, ...(ask.vault === undefined ? {} : { vault: ask.vault }),
    ...(ask.signingKey === undefined ? {} : { signingKey: ask.signingKey }),
    ...(ask.invitedBy === undefined ? {} : { invitedBy: ask.invitedBy }),
  }), dialog);
  const read = readRecordsKeyAnswer(answer, {
    atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, account: ask.account, seat: ask.seat.toLowerCase(),
    ...(ask.vault === undefined ? {} : { vault: ask.vault.toLowerCase() }),
    ...(ask.signingKey === undefined ? {} : { signingKey: ask.signingKey.toLowerCase() }),
  });
  if (!read.ok) {
    const refused = read as Extract<typeof read, { ok: false }>;
    throw new WalletDidNotSignRecordsKey(refused.code, refused.says);
  }
  return { committeeKey: read.committeeKey, statement: read.statement, seats: read.seats, vault: read.vault, entry: read.entry };
}

/* ------------------------------------------------------------------ who holds it, with no press */

const HOLDERS_WINDOW_MS = 2 * 60_000;
const HOLDERS_PURPOSE =
  'So this page believes only what your company\'s signers filed: your wallet says who holds your company now, as it reads '
  + 'the network. Nothing is signed and nothing private is shared.';

class WalletDidNotSayWhoHolds extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WalletDidNotSayWhoHolds';
  }
}

export interface HoldersAsked {
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  /** Entries of the account's record of payments to ask about; the answer then says which it holds, and its pay-key commitment. */
  readonly movements?: readonly string[];
  readonly atOrigin: string;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
  readonly nonce?: string;
}

/** What comes back, checked: who holds the account, what it has adopted, and the account it was read for. */
export interface HoldersRead {
  readonly holders: AccountHoldersRead;
  /** Present exactly when the ask named entries of the account's record of payments. */
  readonly payments?: AccountPaymentFacts;
  /** The indexer the wallet read through, which this device reads the company's vaults through; null when it said none. */
  readonly indexer: WalletIndexer | null;
}

/**
 * **WHO HOLDS THE COMPANY NOW, AS THE PERSON'S OWN WALLET READS THE CHAIN.**
 * Answered with no press: nothing private is asked for and nothing is signed.
 * Asked afresh for every read that believes a filing, and never kept.
 */
export async function askWalletWhoHolds(
  view: Openable, walletOrigin: string, ask: HoldersAsked, dialog?: WalletDialog,
): Promise<HoldersRead> {
  const now = ask.now ?? (() => Date.now());
  const nonce = ask.nonce ?? toHex(randomBytes(16));
  const answer = await askWallet(view, walletOrigin, Object.freeze({
    schema: REQUEST_SCHEMA,
    kind: 'holders' as const,
    requester: Object.freeze({ name: ask.name, rdns: ask.rdns }),
    purpose: HOLDERS_PURPOSE,
    nonce,
    expiresAt: now() + HOLDERS_WINDOW_MS,
    company: ask.company,
    account: ask.account,
    ...(ask.movements === undefined ? {} : { movements: [...ask.movements] }),
  }), dialog);
  const read = readHoldersAnswer(answer, {
    atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, account: ask.account,
    ...(ask.movements === undefined ? {} : { movements: ask.movements }),
  });
  if (!read.ok) {
    const refused = read as Extract<typeof read, { ok: false }>;
    throw new WalletDidNotSayWhoHolds(refused.code, refused.says);
  }
  return read.payments === undefined
    ? { holders: read.holders, indexer: read.indexer }
    : { holders: read.holders, payments: read.payments, indexer: read.indexer };
}

/* ------------------------------------------------------------------ addresses and balances, after one press */

const ADDRESSES_AND_BALANCES_WINDOW_MS = 10 * 60_000;
const ADDRESSES_AND_BALANCES_PURPOSE =
  'So this page can show you where your wallet receives and what it holds: your wallet shows you exactly what it will '
  + 'hand over, and hands it over only if you press. Nothing is signed.';

class WalletDidNotShowAddressesAndBalances extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WalletDidNotShowAddressesAndBalances';
  }
}

interface AddressesAndBalancesAsked {
  readonly atOrigin: string;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
  readonly nonce?: string;
}

/**
 * **WHERE THE PERSON'S WALLET RECEIVES, AND WHAT IT HOLDS, AFTER THEIR PRESS.**
 * The wallet shows the person its private and public receiving addresses and
 * every token it holds on each side, and hands them over only on one press on
 * its own screen, every time this is asked. Which of their wallets answers is
 * theirs to choose there. What comes back is checked against this page's own
 * origin and nonce, and is `AddressesAndBalancesShown`
 * (`midnight-identity/profile/addresses-and-balances`): two addresses, the
 * amounts each marked `private` or `public`, and the moment each side was read,
 * or `null` for a side the wallet could not read - which is not known, never
 * zero. A refusal, a decline or a wallet that never answers throws, and
 * nothing is handed over.
 */
export async function askWalletForAddressesAndBalances(
  view: Openable, walletOrigin: string, ask: AddressesAndBalancesAsked, dialog?: WalletDialog,
): Promise<{ readonly shown: AddressesAndBalancesShown; readonly at: number }> {
  const now = ask.now ?? (() => Date.now());
  const nonce = ask.nonce ?? toHex(randomBytes(16));
  const answer = await askWallet(view, walletOrigin, Object.freeze({
    schema: REQUEST_SCHEMA,
    kind: 'addresses-and-balances' as const,
    requester: Object.freeze({ name: ask.name, rdns: ask.rdns }),
    purpose: ADDRESSES_AND_BALANCES_PURPOSE,
    nonce,
    expiresAt: now() + ADDRESSES_AND_BALANCES_WINDOW_MS,
  }), dialog);
  const read = readAddressesAndBalancesAnswer(answer, { atOrigin: ask.atOrigin, expectingNonce: nonce });
  if (!read.ok) {
    const refused = read as Extract<typeof read, { ok: false }>;
    throw new WalletDidNotShowAddressesAndBalances(refused.code, refused.says);
  }
  return { shown: read.shown, at: read.at };
}

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
import { REQUEST_SCHEMA } from 'midnight-identity/profile/request';
import {
  readRecordsKeyAnswer, type AccountSeats, type RecordsKeyStatement, type VaultHolders,
} from 'midnight-identity/profile/records-key';
import type { AccountAddress, CompanyLabel, VaultAddress } from 'midnight-identity/profile/company-label';
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
  readonly atOrigin: string;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
  readonly nonce?: string;
}

/** The ask on the wire. */
const recordsKeyAsk = (parts: {
  name: string; rdns: string; purpose: string; nonce: string; expiresAt: number;
  company: CompanyLabel; account: AccountAddress; seat: string; vault?: VaultAddress;
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
});

/** What comes back, checked: the statement, the committee key it verifies against, and who holds the account. */
export interface RecordsKeySigned {
  readonly committeeKey: { readonly tag: string; readonly value: string };
  readonly statement: RecordsKeyStatement;
  readonly seats: AccountSeats;
  /** Who holds the vault asked about, as the wallet read it; null when no vault was asked about. */
  readonly vault: VaultHolders | null;
}

export async function askWalletToSignRecordsKey(
  view: Openable, walletOrigin: string, ask: RecordsKeyAsked, dialog?: WalletDialog,
): Promise<RecordsKeySigned> {
  const now = ask.now ?? (() => Date.now());
  const nonce = ask.nonce ?? toHex(randomBytes(16));
  const answer = await askWallet(view, walletOrigin, recordsKeyAsk({
    name: ask.name, rdns: ask.rdns, purpose: RECORDS_KEY_PURPOSE, nonce, expiresAt: now() + RECORDS_KEY_WINDOW_MS,
    company: ask.company, account: ask.account, seat: ask.seat, ...(ask.vault === undefined ? {} : { vault: ask.vault }),
  }), dialog);
  const read = readRecordsKeyAnswer(answer, {
    atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, account: ask.account, seat: ask.seat.toLowerCase(),
    ...(ask.vault === undefined ? {} : { vault: ask.vault.toLowerCase() }),
  });
  if (!read.ok) {
    const refused = read as Extract<typeof read, { ok: false }>;
    throw new WalletDidNotSignRecordsKey(refused.code, refused.says);
  }
  return { committeeKey: read.committeeKey, statement: read.statement, seats: read.seats, vault: read.vault };
}

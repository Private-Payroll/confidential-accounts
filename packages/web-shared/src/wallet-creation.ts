/**
 * **ASKING THE FOUNDING SIGNER'S OWN WALLET TO FINISH CREATING THEIR COMPANY'S
 * ACCOUNT.**
 *
 * The page hands over the account's deploy, unsent, and the keys the second
 * step inserts. The wallet reads the deploy itself, checks it is held by its
 * own key for the label it drew, pins that address, builds the insert of the
 * other keys for it, shows the label and the address, and on the person's
 * press hands back only the signature. No key crosses.
 *
 * Every expectation the answer is checked against is this page's own: where it
 * is, the nonce it chose, the company, the account and the key it was given.
 */
import { REQUEST_SCHEMA, type InsertedKeyOnTheWire } from 'midnight-identity/profile/request';
import { readCreationSignature } from 'midnight-identity/profile/creation-sign';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { toHex, randomBytes } from '../../../src/core/crypto.js';
import { askWallet, type Openable, type WalletDialog } from './wallet-sign-in.js';
import { WalletDidNotSign } from './wallet-committee.js';

/** How long the wallet has to answer. */
const CREATION_WINDOW_MS = 10 * 60_000;

const CREATION_PURPOSE =
  'To finish creating your company\'s account. This screen shows the company, the account and that it is held by your '
  + 'own key from its first transaction.';

type Key = { tag: 'schnorr'; value: string };

interface CreationAsked {
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  /** The deploy, unsent, as base64. */
  readonly deploy: string;
  readonly insert: readonly InsertedKeyOnTheWire[];
  /** The key this wallet gave for the company, which the deploy is held by. */
  readonly signer: Key;
  readonly atOrigin: string;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
  readonly nonce?: string;
}

/** The ask on the wire. */
const creationAsk = (parts: {
  name: string; rdns: string; purpose: string; nonce: string; expiresAt: number;
  company: CompanyLabel; account: AccountAddress; deploy: string; insert: readonly InsertedKeyOnTheWire[];
}) => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: 'creation' as const,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: parts.purpose,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
  company: parts.company,
  account: parts.account,
  deploy: parts.deploy,
  insert: parts.insert.map((k) => ({ circuit: k.circuit, key: k.key })),
});

export async function askWalletToFinishCreation(
  view: Openable, walletOrigin: string, ask: CreationAsked, dialog?: WalletDialog,
): Promise<{ signer: Key; signature: { tag: string; value: string } }> {
  const now = ask.now ?? (() => Date.now());
  const nonce = ask.nonce ?? toHex(randomBytes(16));
  const answer = await askWallet(view, walletOrigin, creationAsk({
    name: ask.name, rdns: ask.rdns, purpose: CREATION_PURPOSE, nonce, expiresAt: now() + CREATION_WINDOW_MS,
    company: ask.company, account: ask.account, deploy: ask.deploy, insert: ask.insert,
  }), dialog);
  const read = readCreationSignature(answer, {
    atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, account: ask.account, signer: ask.signer,
  });
  if (!read.ok) {
    const refused = read as Extract<typeof read, { ok: false }>;
    throw new WalletDidNotSign(refused.code, refused.says);
  }
  return { signer: { tag: 'schnorr', value: read.signer.value }, signature: read.signature };
}

/**
 * **ASKING THE SIGNED-IN PERSON'S OWN WALLET TO SIGN A CHANGE TO WHO HOLDS
 * THEIR COMPANY'S RULES.**
 *
 * The page names the committee to install and, for each contract, the counter
 * the chain holds and the committee holding it now. The wallet builds the one
 * change that installs that committee, shows who joins, who leaves and the new
 * threshold, and on the person's press hands back its signatures. No key
 * crosses; the signatures are good for exactly that change.
 *
 * Every expectation the answer is checked against is this page's own: where it
 * is, the nonce it chose, the company, the committee and the contracts it named.
 */
import { REQUEST_SCHEMA } from 'midnight-identity/profile/request';
import {
  COMMITTEE_JOIN_SCHEMA, COMMITTEE_REQUEST_SCHEMA, readCommitteeSignatures, readKeySignature, type CommitteeSeatSignature, type KeySignatureRead,
} from 'midnight-identity/profile/committee-sign';
import type { SuperAdminChangeOnTheWire } from 'midnight-identity/profile/request';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { toHex, randomBytes } from '../../../src/core/crypto.js';
import { askWallet, type Openable, type WalletDialog } from './wallet-sign-in.js';

/** How long the wallet has to answer. */
export const COMMITTEE_WINDOW_MS = 10 * 60_000;

export const COMMITTEE_PURPOSE =
  'To bring your company\'s account and vaults up to date with its super admins as the chain holds them. This screen '
  + 'shows who joins, who leaves and how many must sign after the change.';

export class WalletDidNotSign extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WalletDidNotSign';
  }
}

type Key = { tag: string; value: string };
type CommitteeValue = { committee: readonly Key[]; threshold: number };

export interface CommitteeAsked {
  /** The company's label, and the account that carries it: the wallet reads one off the other. */
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly to: CommitteeValue;
  readonly contracts: ReadonlyArray<{ contract: 'account' | 'vault'; address: string; counter: string; now: CommitteeValue }>;
  readonly atOrigin: string;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
  readonly nonce?: string;
}

const keysOf = (c: CommitteeValue) => ({
  committee: c.committee.map((k) => ({ tag: 'schnorr' as const, value: k.value.toLowerCase() })),
  threshold: c.threshold,
});

/** The ask on the wire. No bytes to sign travel: the wallet builds the change from these. */
export const committeeAsk = (parts: {
  name: string; rdns: string; purpose: string; nonce: string; expiresAt: number;
  company: CompanyLabel; account: AccountAddress; to: CommitteeValue; contracts: CommitteeAsked['contracts'];
}) => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: 'committee' as const,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: parts.purpose,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
  company: parts.company,
  account: parts.account,
  to: keysOf(parts.to),
  contracts: parts.contracts.map((c) => ({ contract: c.contract, address: c.address, counter: c.counter, now: keysOf(c.now) })),
});

export async function askWalletToSignCommittee(
  view: Openable, walletOrigin: string, ask: CommitteeAsked, dialog?: WalletDialog,
): Promise<{ signer: Key; signatures: readonly CommitteeSeatSignature[] }> {
  const now = ask.now ?? (() => Date.now());
  const nonce = ask.nonce ?? toHex(randomBytes(16));
  const answer = await askWallet(view, walletOrigin, committeeAsk({
    name: ask.name, rdns: ask.rdns, purpose: COMMITTEE_PURPOSE, nonce, expiresAt: now() + COMMITTEE_WINDOW_MS,
    company: ask.company, account: ask.account, to: ask.to, contracts: ask.contracts,
  }), dialog);
  const read = readCommitteeSignatures(answer, {
    atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, account: ask.account,
    to: keysOf(ask.to), contracts: ask.contracts,
  });
  if (!read.ok) {
    const refused = read as Extract<typeof read, { ok: false }>;
    throw new WalletDidNotSign(refused.code, refused.says);
  }
  return { signer: read.signer, signatures: read.signatures };
}

/** What a super admin's page tells the wallet it asks for, before the wallet shows the change itself. */
const SUPER_ADMINS_PURPOSE = 'To change who your company\'s super admins are. This screen shows the change as your wallet reads it on the chain.';
const SUPER_ADMIN_REQUEST_PURPOSE = 'To let you act as one of your company\'s super admins on this site. This changes no contract and moves no money.';

/** The parts every committee press carries: who asks, why, the one-time nonce, its window, and the company. */
interface PressAsked {
  readonly company: CompanyLabel;
  readonly account: AccountAddress;
  readonly atOrigin: string;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
  readonly nonce?: string;
}

const pressAsk = (ask: PressAsked, purpose: string, press: Readonly<Record<string, unknown>>) => {
  const nonce = ask.nonce ?? toHex(randomBytes(16));
  const now = ask.now ?? (() => Date.now());
  return {
    nonce,
    body: Object.freeze({
      schema: REQUEST_SCHEMA, kind: 'committee' as const, requester: Object.freeze({ name: ask.name, rdns: ask.rdns }), purpose, nonce,
      expiresAt: now() + COMMITTEE_WINDOW_MS, company: ask.company, account: ask.account, ...press,
    }),
  };
};

const keySignatureOf = (read: KeySignatureRead): { signer: Key; signature: string } => {
  if (!read.ok) {
    const refused = read as Extract<KeySignatureRead, { ok: false }>;
    throw new WalletDidNotSign(refused.code, refused.says);
  }
  return { signer: read.signer, signature: read.signature };
};

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The super-admins press: the wallet signs every contract's update the change names that its key holds a place on. */
export async function askWalletToSignSuperAdminUpdates(
  view: Openable, walletOrigin: string,
  ask: PressAsked & {
    readonly salt: string; readonly change: SuperAdminChangeOnTheWire; readonly bytes: Uint8Array;
    readonly joined: ReadonlyArray<{ readonly key: Key; readonly signature: string }>;
    readonly contracts: ReadonlyArray<{ readonly contract: 'account' | 'vault'; readonly address: string; readonly counter: string }>;
  },
  dialog?: WalletDialog,
): Promise<{ signer: Key; signatures: readonly CommitteeSeatSignature[] }> {
  const { nonce, body } = pressAsk(ask, SUPER_ADMINS_PURPOSE, {
    change: ask.change, salt: ask.salt, changeBytes: hexOf(ask.bytes),
    joined: ask.joined.map((j) => ({ key: { tag: j.key.tag, value: j.key.value }, signature: j.signature })),
    contracts: ask.contracts.map((c) => ({ contract: c.contract, address: c.address, counter: c.counter })),
  });
  const read = readCommitteeSignatures(await askWallet(view, walletOrigin, body, dialog), {
    atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, account: ask.account,
    to: keysOf({ committee: ask.change.committee, threshold: ask.change.threshold }), contracts: ask.contracts,
  });
  if (!read.ok) {
    const refused = read as Extract<typeof read, { ok: false }>;
    throw new WalletDidNotSign(refused.code, refused.says);
  }
  return { signer: read.signer, signatures: read.signatures };
}

/** The join press: the wallet signs the change's bytes with its key for the company, which the change puts on the committee. */
export async function askWalletToSignTheChange(
  view: Openable, walletOrigin: string,
  ask: PressAsked & { readonly salt: string; readonly change: SuperAdminChangeOnTheWire; readonly bytes: Uint8Array },
  dialog?: WalletDialog,
): Promise<{ signer: Key; signature: string }> {
  const { nonce, body } = pressAsk(ask, SUPER_ADMINS_PURPOSE, { change: ask.change, salt: ask.salt, changeBytes: hexOf(ask.bytes), joining: true });
  return keySignatureOf(readKeySignature(await askWallet(view, walletOrigin, body, dialog), {
    schema: COMMITTEE_JOIN_SCHEMA, atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, account: ask.account,
  }));
}

/** The request press: the wallet signs, with its key for the company, that `user` asks the service about company `record` as a super admin. */
export async function askWalletToSignTheRequest(
  view: Openable, walletOrigin: string, ask: PressAsked & { readonly record: string; readonly user: string }, dialog?: WalletDialog,
): Promise<{ signer: Key; signature: string }> {
  const { nonce, body } = pressAsk(ask, SUPER_ADMIN_REQUEST_PURPOSE, { record: ask.record, user: ask.user });
  return keySignatureOf(readKeySignature(await askWallet(view, walletOrigin, body, dialog), {
    schema: COMMITTEE_REQUEST_SCHEMA, atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, account: ask.account,
  }));
}

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
import { readCommitteeSignatures, type CommitteeSeatSignature } from 'midnight-identity/profile/committee-sign';
import { toHex, randomBytes } from '../core/crypto.js';
import { askWallet, type Openable, type WalletDialog } from './wallet-sign-in.js';

/** How long the wallet has to answer. */
export const COMMITTEE_WINDOW_MS = 10 * 60_000;

export const COMMITTEE_PURPOSE =
  'To bring your company\'s account and vaults up to date with its current signers. This screen shows who joins, who '
  + 'leaves and how many must sign after the change.';

export class WalletDidNotSign extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WalletDidNotSign';
  }
}

type Key = { tag: string; value: string };
type CommitteeValue = { committee: readonly Key[]; threshold: number };

export interface CommitteeAsked {
  readonly company: string;
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
  company: string; to: CommitteeValue; contracts: CommitteeAsked['contracts'];
}) => Object.freeze({
  schema: REQUEST_SCHEMA,
  kind: 'committee' as const,
  requester: Object.freeze({ name: parts.name, rdns: parts.rdns }),
  purpose: parts.purpose,
  nonce: parts.nonce,
  expiresAt: parts.expiresAt,
  company: parts.company,
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
    company: ask.company, to: ask.to, contracts: ask.contracts,
  }), dialog);
  const read = readCommitteeSignatures(answer, {
    atOrigin: ask.atOrigin, expectingNonce: nonce, company: ask.company, to: keysOf(ask.to), contracts: ask.contracts,
  });
  if (!read.ok) {
    const refused = read as Extract<typeof read, { ok: false }>;
    throw new WalletDidNotSign(refused.code, refused.says);
  }
  return { signer: read.signer, signatures: read.signatures };
}

/**
 * **ASKING THE PERSON'S WALLET FOR A JOIN CODE**, and checking what comes back
 * before anything is shown or sent: it must be signed by the wallet it names,
 * for the company asked about, the person signed in here, and exactly the
 * parts this page asked to be signed.
 */
import { REQUEST_SCHEMA } from 'midnight-identity/profile/request';
import { joinCodeSignedBy, readJoinParts, type JoinCode, type JoinParts } from 'midnight-identity/profile/join-code';
import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { toHex, randomBytes } from '../../../src/core/crypto.js';
import { askWallet, type Openable, type WalletDialog } from './wallet-sign-in.js';

/** How long the wallet has to answer: long enough to read the screen and press. */
const JOIN_CODE_WINDOW_MS = 10 * 60_000;

const JOIN_CODE_PURPOSE =
  'So the company can add you without sending you a link: your wallet signs the public parts of what you join with, and '
  + 'shows you the fingerprint to read to the person adding you.';

/** Thrown when the wallet did not hand back the code asked for; nothing was shown or sent. */
export class WalletDidNotMakeTheCode extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletDidNotMakeTheCode';
  }
}

interface JoinCodeAsked {
  readonly company: CompanyLabel;
  /** The account that carries the label: the wallet reads it off the chain and shows the company's fingerprint from it. */
  readonly account: AccountAddress;
  /** The id this person signed in to the service with. */
  readonly person: string;
  readonly parts: JoinParts;
  readonly name: string;
  readonly rdns: string;
  readonly now?: () => number;
}

/** The code the wallet made, checked as the one asked for. */
export async function askWalletForAJoinCode(
  view: Openable, walletOrigin: string, ask: JoinCodeAsked, dialog?: WalletDialog,
): Promise<JoinCode> {
  const now = ask.now ?? (() => Date.now());
  const answer = await askWallet(view, walletOrigin, Object.freeze({
    schema: REQUEST_SCHEMA,
    kind: 'join-code' as const,
    requester: Object.freeze({ name: ask.name, rdns: ask.rdns }),
    purpose: JOIN_CODE_PURPOSE,
    nonce: toHex(randomBytes(16)),
    expiresAt: now() + JOIN_CODE_WINDOW_MS,
    company: ask.company,
    account: ask.account,
    person: ask.person,
    parts: ask.parts,
  }), dialog);
  const code = answer as JoinCode;
  if (!joinCodeSignedBy(code)) throw new WalletDidNotMakeTheCode('The wallet\'s answer is not a code it signed, so nothing is shown.');
  if (code.company !== ask.company || code.person !== ask.person
    || JSON.stringify(readJoinParts(code.parts)) !== JSON.stringify(readJoinParts(ask.parts))) {
    throw new WalletDidNotMakeTheCode('The wallet signed a code for something other than what this page asked, so nothing is shown.');
  }
  return code;
}

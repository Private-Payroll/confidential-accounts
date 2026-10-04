/**
 * **THE COMPANY'S PAY-RECORD KEY ON ITS ACCOUNT**: the proposal that commits the
 * account to the key, and each signer's sealed copy of it.
 *
 * The key is made with the company, on its founding signer's device, and kept
 * sealed in the company's first state. On the chain the account holds two
 * things about it: a commitment to the key, written once under a proposal its
 * signers approved, and for each signer four entries that only that signer can
 * open, under keys only they can work out. A device checks the key it opened
 * against the commitment before it derives anything from it.
 *
 * **THE PROPOSAL IS THE SAME PROPOSAL ON EVERY DEVICE.** Its salt is worked out from
 * the commitment, so the proposal's identity follows from the key alone and a
 * device that stopped half way, or another of the founding signer's devices,
 * raises, approves and carries out the same proposal rather than a second one.
 *
 * Pure: the contract's own functions are handed in, and this file loads no
 * WebAssembly.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex, utf8, type Hex } from '../core/crypto.js';
import { standingOf, type AccountLedgerForAStart, type RoundStanding } from './vault-start.js';

const HEX32 = /^[0-9a-f]{64}$/u;
const PAY_KEY_SALT = utf8('confidential-accounts/pay-record-key-proposal/salt/v1');

/** The account's own functions the pay-record key's proposal and copies are made with. */
export interface PayKeyPure {
  payKeyCommitmentOf(key: Uint8Array): Uint8Array;
  payKeyPayload(commitment: Uint8Array): Uint8Array;
  payKeyCommitmentKey(): Uint8Array;
  payKeyWrapKeyOf(account: Uint8Array, sk: Uint8Array, part: bigint): Uint8Array;
  proposalIdOf(payload: Uint8Array, vault: Uint8Array, salt: Uint8Array): Uint8Array;
  noVault(): Uint8Array;
  removalCountKey(): Uint8Array;
}

/** How many 32-byte entries one signer's sealed copy takes on the account. */
export const PAY_KEY_PARTS = 4;

/** The proposal that commits the account to one pay-record key: what it commits to, its salt and its identity. */
export interface PayKeyRound {
  readonly commitment: Hex;
  readonly payload: Hex;
  readonly salt: Hex;
  readonly proposal: Hex;
}

const bytes32 = (name: string, h: string): Uint8Array => {
  if (typeof h !== 'string' || !HEX32.test(h.toLowerCase())) {
    throw new Error(`the ${name} is not thirty-two bytes, so nothing was worked out from it.`);
  }
  return fromHex(h.toLowerCase());
};

export function payKeyRoundOf(P: PayKeyPure, key: Hex): PayKeyRound {
  const commitment = P.payKeyCommitmentOf(bytes32('pay-record key', key));
  const payload = P.payKeyPayload(commitment);
  const salt = sha256(new Uint8Array([...PAY_KEY_SALT, ...commitment]));
  return {
    commitment: toHex(commitment), payload: toHex(payload), salt: toHex(salt),
    proposal: toHex(P.proposalIdOf(payload, P.noVault(), salt)),
  };
}

/** The account's map the pay-record key's commitment and copies sit in, as its ledger reads it. */
export interface PayKeyRoles {
  member(k: Uint8Array): boolean;
  lookup(k: Uint8Array): Uint8Array;
}

/**
 * **ONE SIGNER'S SEALED COPY OF THE PAY-RECORD KEY, AS THE ACCOUNT AT `address`
 * HOLDS IT**: its four entries, under the keys the contract derives from that
 * address's thirty-two bytes and the signer's secret key, or null when they
 * have sealed none. The secret key only works the keys out; it is not looked
 * up and goes nowhere.
 */
export function sealedPayKeyIn(P: Pick<PayKeyPure, 'payKeyWrapKeyOf'>, roles: PayKeyRoles, address: string, secretKey: Hex): Hex[] | null {
  const self = fromHex(String(address).toLowerCase().replace(/^0x/u, ''));
  if (self.length !== 32) throw new Error(`this account's address is not 32 bytes: ${address}`);
  const sk = bytes32('signer\'s secret key', secretKey);
  const keys = Array.from({ length: PAY_KEY_PARTS }, (_, i) => P.payKeyWrapKeyOf(self, sk, BigInt(i)));
  if (!roles.member(keys[0]!)) return null;
  return keys.map((k) => toHex(roles.lookup(k)));
}

/** The account's commitment to its pay-record key, as its ledger holds it, or null when none is written. */
export function payKeyCommitmentIn(P: Pick<PayKeyPure, 'payKeyCommitmentKey'>, roles: PayKeyRoles): Hex | null {
  const at = P.payKeyCommitmentKey();
  return roles.member(at) ? toHex(roles.lookup(at)) : null;
}

/** Where the pay-record key stands on the account, for one signer. */
export interface PayKeyStanding {
  /** The commitment the account holds, or null when none is written yet. */
  readonly committed: Hex | null;
  /** Whether that commitment is to this key. Meaningless while nothing is committed. */
  readonly isThisKey: boolean;
  /** Whether the signer asking has sealed their own copy. */
  readonly sealedMine: boolean;
  /** The proposal that commits the account to this key. */
  readonly round: PayKeyRound & RoundStanding;
}

/** The parts of the account's ledger the pay-record key's standing reads. */
export type AccountLedgerForThePayKey =
  Pick<AccountLedgerForAStart, 'threshold' | 'openProposals' | 'approvalCounts' | 'proposalHolds'> & { readonly signerRoles: PayKeyRoles };

export function payKeyStandingOf(
  P: PayKeyPure,
  input: { readonly address: string; readonly account: AccountLedgerForThePayKey; readonly key: Hex; readonly secretKey: Hex },
): PayKeyStanding {
  const round = payKeyRoundOf(P, input.key);
  const committed = payKeyCommitmentIn(P, input.account.signerRoles);
  return {
    committed,
    isThisKey: committed !== null && committed === round.commitment,
    sealedMine: sealedPayKeyIn(P, input.account.signerRoles, input.address, input.secretKey) !== null,
    round: { ...round, ...standingOf(P, input.account, round.proposal, input.account.threshold, false) },
  };
}

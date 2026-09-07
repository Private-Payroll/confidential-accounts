/**
 * The public API. The only thing another product imports.
 *
 * Nothing here touches a browser, a disk or a network — see `ARCHITECTURE.md`.
 * The browser half lives behind `midnight-identity/browser` and a server-side
 * host never pulls it into its bundle.
 */

export {
  DerivationError, Purposes, SECRET_BYTES, WORD_COUNT,
  identityFromSecret, identityFromWords, newSecret, newWords,
  secretFromWords, seedFromWords, wordsFromSecret,
} from './keys/derivation.js';
export type {
  AuthorityKey, DerivationFailure, Identity, MoneyKey, MoneyKeys, Purpose, Secret,
} from './keys/derivation.js';

export {
  Algorithms, PasskeyError, signCountLooksCloned, verifyAssertion, verifyRegistration,
} from './passkey/verify.js';
export type {
  AssertionInput, AssertionResult, Expectations, Passkey, PasskeyFailure, RegistrationInput,
} from './passkey/verify.js';

export { MemoryChallengeStore } from './passkey/challenges.js';
export type { MemoryChallengeStoreOptions } from './passkey/challenges.js';

export { fromBase64Url, sameBytes, toBase64Url } from './passkey/bytes.js';

export {
  PAIRING_TTL_MS, PairingError, acceptKeys, answerCommitment, askToPair, beginOffer,
  checkAndShow, digitsFor, revealAndShow, sealKeys,
} from './devices/pairing.js';
export type {
  Commitment, PairingFailure, PairingRequest, Reveal, SealedKeys,
} from './devices/pairing.js';
export { PendingOffer } from './devices/pairing.js';

export {
  MAX_PIECES, RecoveryError, checkPlan, combinePieces, fingerprintOf, hasNoMargin,
  proveRecoverable, readPieceHeader, splitSecret, suggestDefault, warningsFor,
} from './recovery/pieces.js';
export type {
  Piece, PieceHeader, PieceSet, Placement, RecoveryFailure, Warning,
} from './recovery/pieces.js';

export {
  advance, cancelRecovery, completeRecovery, offerPiece, progress, startRecovery, withdrawPiece,
} from './recovery/session.js';
export type {
  OfferedPiece, Recovered, RecoverySession, RecoveryState, StartOptions,
} from './recovery/session.js';

export {
  LockError, checkLockPlan, lockPiece, proveStoredPieceOpens, recoveryKeyOf, recoveryKeypair,
  unlockPiece,
} from './recovery/locks.js';
export type { LockFailure, RecoveryKeypair } from './recovery/locks.js';

export {
  AddressError, addressFor, payeeAddress, samePayee, shortPayee,
} from './wallet/address.js';
export type { AddressFailure, PayeeAddress } from './wallet/address.js';

export { NETWORK, NETWORKS, isNetworkName, networkName } from './wallet/network.js';
export type { NetworkName } from './wallet/network.js';

export type {
  ChallengeStore, KeyringStore, PasskeyStore, PieceHome, PieceLock,
  Received, WalletReader, WalletSpender,
} from './ports.js';

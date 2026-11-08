import type { Hex } from '../../../src/core/crypto.js';
import type { ReaderRefusalCode } from '../../../src/midnight/secret-readers.js';

/** A vault that is not one its company's account adopted as the chain shows it. Nothing is set up, put in or paid from it. */
export class VaultNotTheCompanys extends Error {
  /**
   * `'not-adopted'`: the wallet read the account and the vault is not among the vaults it adopted. `'wallet-silent'`: the
   * wallet could not say who holds the company, so nothing is known. `'other'`: a vault that was not set up as the company's.
   */
  constructor(readonly vault: Hex, why: string, readonly kind: 'not-adopted' | 'wallet-silent' | 'other' = 'other') {
    super(`${why} Nothing was sent.`);
    this.name = 'VaultNotTheCompanys';
  }
}

/** The vault could not be read on this device, and the service is not asked in its place. Nothing was sent. */
export class VaultNotReadHere extends Error {
  constructor(readonly vault: Hex, why: string, options?: ErrorOptions) {
    super(`${why} The company's service is not asked in its place. Nothing was sent.`, options);
    this.name = 'VaultNotReadHere';
  }
}

/** Which contract's circuit is not this app's, the circuit when one is named, and why. */
export interface CircuitNotThisBuilds {
  readonly contract: 'vault' | 'account';
  readonly circuit: string | null;
  readonly why: string;
}

export const sentNothing = (e: unknown): boolean => (e as { nothingWasSent?: unknown })?.nothingWasSent === true;

/** Where the press ended: the vault started, or a round of its start waiting for other signers' approvals. */
export type VaultCreated = (
  | { readonly vault: Hex; readonly state: 'started' }
  | {
    readonly vault: Hex; readonly state: 'awaiting-approvals';
    /** Which round waits, its identity, and how many approvals it has and needs. */
    readonly awaiting: {
      readonly round: 'adoption' | 'first-secret'; readonly proposal: Hex;
      readonly approvals: number; readonly needed: number;
    };
  }
) & {
  /**
   * What this press could not leave in the company's records, each said in a
   * sentence: the vault's name and description when they were given and not
   * filed, and each of the vault's two setup proposals the chain holds and that
   * was not written down. The start carries on without them, since nothing it
   * does reads those records.
   */
  readonly said?: readonly string[];
  /**
   * The kind of each thing in `said`, once each, in the order they were first
   * said: what a page words in its own language instead of showing the
   * English in `said`.
   */
  readonly saidCodes?: readonly SaidCode[];
};

/** The kinds of thing a press can leave unsaid in the company's records and still carry on. */
export const SAID = {
  proposalNotWrittenDown: 'proposal-not-written-down',
  nameNotFiled: 'vault-name-not-filed',
  nameGivenBefore: 'vault-name-given-before',
} as const;
export type SaidCode = (typeof SAID)[keyof typeof SAID];

/** Why no vault was built, before anything was sent: what a page words, with what resolves each. */
export const NOT_BUILT = {
  seatUnknown: 'seat-unknown',
  seatNotBelieved: 'seat-not-believed',
  seatMayNotRaise: 'seat-may-not-raise',
  committeeUnread: 'committee-unread',
  committeeNotInstallable: 'committee-not-installable',
  pageOutOfDate: 'page-out-of-date',
} as const;
export type NotBuiltCode = (typeof NOT_BUILT)[keyof typeof NOT_BUILT];

/**
 * **THE KINDS OF STOP A START CAN MAKE BESIDE THE CHECK OF WHO ITS SECRET IS SEALED TO.**
 * The first four cannot be cleared by pressing again; the last is the wallet's
 * own ask for the first secret failing.
 */
export const START_STOP = {
  adoptionStale: 'adoption-stale', tooFewApprovers: 'too-few-approvers', anotherSecret: 'another-secret',
  readersCannotOpen: 'readers-cannot-open', readBackOnly: 'read-back-only', walletNotAnswered: 'wallet-not-answered',
} as const;
export type StartStopCode = ReaderRefusalCode | (typeof START_STOP)[keyof typeof START_STOP];

/**
 * **WHICH READ ON THIS DEVICE A START STOPPED AT.** The chain at one block could not be read, or where the start
 * stands could not be worked out from it. Pressing again can clear either. Carried with the stop so it says which
 * read failed, never what was read.
 */
export const START_READ_STOP = { chainUnread: 'chain-unread', standingUnread: 'standing-unread' } as const;
export type StartReadStopCode = (typeof START_READ_STOP)[keyof typeof START_READ_STOP];

/**
 * Why an adoption raised before a removal is never carried out, and what is left: the chain refuses it for good
 * (`requireApproved`), and raised again under the same identity it could not count an earlier approver, so this app
 * neither withdraws it nor raises it again.
 */
export const STALE_ADOPTION = 'a signer was removed or replaced after its adoption was raised, so the chain will never carry that '
  + 'adoption out, and this app neither withdraws it nor raises it again. The vault holds nothing: create a new vault instead.';

/**
 * **THE VAULT WAS SENT AND ITS START IS NOT FINISHED.**
 * Names the vault and the step; the vault takes no money until it is started,
 * and running `createCompanyVault` again for it carries on from what the chain
 * shows. It holds nothing.
 */
export class VaultStartOwed extends Error {
  /**
   * When the start stopped for a reason of its own: what kind of thing stopped it; or, as a `START_READ_STOP`, which
   * read on this device failed. Absent where pressing again is all that is left and no read is to name.
   */
  readonly stoppedAt?: StartStopCode | StartReadStopCode;
  /** Why it stopped, as a sentence, without the words about finishing the vault's setup around it. */
  readonly why: string;
  constructor(readonly vault: Hex, why: string, stoppedAt?: StartStopCode | StartReadStopCode) {
    super(`Setting up this vault did not finish: ${why} `
      + 'This app puts no money into it until it is set up. Finish setting it up to carry on.');
    this.name = 'VaultStartOwed';
    this.why = why;
    if (stoppedAt !== undefined) this.stoppedAt = stoppedAt;
  }
}

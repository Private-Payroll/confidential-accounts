import type { AccountAddress, CompanyLabel } from 'midnight-identity/profile/company-label';
import { PROPOSAL_ACTED } from 'vaults-web-shared/proposal-in-the-wallet.js';
import {
  approveRecoveryInTheWallet, carryOutRecoveryInTheWallet, FILE_OPENED, FILE_REFUSED, HELD_ON_CHAIN, isRecoveryParts, raiseRecoveryInTheWallet, recoveryFileName,
  recoveryFileTextOf, recoveryLatestAt, recoveryOutcomeOf, recoveryPartsInFile, RECOVERY_ACT, RECOVERY_FILE_ACCEPT, RECOVERY_STATE, RECOVERY_WHY, RECOVERY_WITHIN, recoveryPartsToldBy, recoveryTimePassed, recoveryUntil, recoveryWhyOf,
  saveFileText, STANDING_READ, type FileRefusal, type HeldOnChain, type RecoveryAct, type RecoveryParts, type RecoveryState, type RecoveryWhy,
  type RecoveryWithin,
} from 'vaults-web-shared/recovery-in-the-wallet.js';
import type { ActOutcome } from 'vaults-web-shared/wallet-act.js';
import { api } from 'vaults-web-shared/keyring.js';
import type { RecordsHeldHere } from 'vaults-web-shared/vault-page-doors.js';
import type { StartedFrom } from 'vaults-web-shared/tree-kept-here.js';
import type { TransitionStop } from '../../../../src/midnight/record-tree.js';
import type { SealedAccount } from '../../../../src/core/types.js';
import { companyKeysFor, directoryWithItsRecordsFor, openedHere, walletIndexerFor } from './filing-judge.js';
import { keyringFor, keysOnTheWayIn } from './keyring-person.js';
import { READ, type Read } from './reads.js';
import { SERVICE } from './company-records.js';
import { ACT_REFUSAL, refusalOf, type ActRefusal } from './refusals.js';
import { ACCOUNT_ORIGIN } from './session.js';
import { theVaultBuilder } from './vault-builder.js';

/*
 * THE RECOVERY PAGE'S ACTS AND READS. A recovery of the company's records is run in the person's own wallet, on the chain alone: raising
 * it, approving it and carrying it out are each one window and one passkey, and each call goes from the wallet's own account, which pays
 * the fee and nothing else. This page names the company, the last time the recovery may be carried out and the parts of its file, and is
 * told back where the chain holds the recovery. The file is made here from what the wallet tells (its parts are public), saved by the
 * person and opened again from their disk; what a file says is read from the chain every time, never from the file. The wallet's names
 * and the codes a stop is told by are the shared code's (`recovery-in-the-wallet.ts`); a screen is handed codes, never words.
 */
export {
  FILE_OPENED, FILE_REFUSED, HELD_ON_CHAIN, PROPOSAL_ACTED as RECOVERED, RECOVERY_ACT, RECOVERY_FILE_ACCEPT, RECOVERY_STATE, RECOVERY_WHY, RECOVERY_WITHIN, STANDING_READ,
  type FileRefusal, type RecoveryAct, type RecoveryState, type RecoveryWhy, type RecoveryWithin,
};

/** The company as the wallet is asked to name it: its record, its label and its account on the network; null for a company with no account yet. */
const namedFor = async (companyId: string): Promise<{ record: string; company: string; account: string } | null> => {
  const sealed = await api(SERVICE.company + companyId) as SealedAccount;
  const company = sealed?.companyLabel, account = sealed?.contractAddress;
  return typeof company === 'string' && typeof account === 'string' ? { record: companyId, company, account } : null;
};

/** A recovery this page holds: its parts, the last moment it may be carried out, and the name its file is saved under. */
export interface RecoveryHere {
  readonly parts: RecoveryParts;
  /** The last moment it may be carried out, as an ISO time. */
  readonly until: string;
  readonly fileName: string;
}

/** A recovery made from its parts; null where the parts are not a recovery's. */
const heldFrom = (parts: RecoveryParts): RecoveryHere | null =>
  (isRecoveryParts(parts) ? { parts, until: recoveryUntil(parts), fileName: recoveryFileName(parts) } : null);

/** How a press on a recovery ended; `held` is the recovery the page holds after it, with its file. */
export type RecoveryActed =
  | {
    readonly of: typeof PROPOSAL_ACTED.done; readonly act: RecoveryAct; readonly state: RecoveryState | null; readonly approvals: number | null;
    readonly needed: number | null; readonly held: RecoveryHere | null;
  }
  | { readonly of: typeof PROPOSAL_ACTED.stopped; readonly act: RecoveryAct; readonly why: RecoveryWhy; readonly partial: boolean; readonly held: RecoveryHere | null }
  | { readonly of: typeof PROPOSAL_ACTED.refused; readonly why: ActRefusal };

const refused = (why: ActRefusal): RecoveryActed => ({ of: PROPOSAL_ACTED.refused, why });

async function actedOf(act: RecoveryAct, ended: ActOutcome, named: Named, held: RecoveryHere | null): Promise<RecoveryActed> {
  const parts = act === RECOVERY_ACT.raise ? recoveryPartsToldBy(named.record, named.account, ended.outcome) : null;
  const here = act === RECOVERY_ACT.raise ? (parts === null ? null : heldFrom(parts)) : held;
  if (ended.of === PROPOSAL_ACTED.done) {
    return { of: PROPOSAL_ACTED.done, act, ...recoveryOutcomeOf(ended), held: here };
  }
  const why = recoveryWhyOf(ended.refused);
  return { of: PROPOSAL_ACTED.stopped, act, why, partial: why === RECOVERY_WHY.mayBeSent || ended.relayed > 0 || ended.unconfirmed > 0, held: here };
}

interface Named { readonly record: string; readonly company: CompanyLabel; readonly account: AccountAddress }

async function namedBefore(personId: string, companyId: string): Promise<Named | ActRefusal> {
  if (ACCOUNT_ORIGIN === '') return ACT_REFUSAL.notSetUp;
  if (!(await keyringFor(personId))) return ACT_REFUSAL.notSignedIn;
  const named = await namedFor(companyId);
  return named === null ? ACT_REFUSAL.didNotFinish : { record: named.record, company: named.company as CompanyLabel, account: named.account as AccountAddress };
}

const onStepOf = (onStep?: (step: number, steps: number) => void) => (onStep === undefined ? {} : { onStep: (at: { step: number; steps: number }) => onStep(at.step, at.steps) });

const isThisCompanys = (held: RecoveryHere, named: Named): boolean =>
  held.parts.company === named.record && held.parts.account.toLowerCase() === named.account.toLowerCase();

/**
 * Ask the person's wallet to raise a recovery of the company's records, to be carried out before `within` from now. The wallet raises it
 * from the last batch of the records it checked, and carries it out in the same window if the chain already counts the approvals the
 * account needs. The file comes back on a stop as well as on a finish, wherever the wallet had raised the recovery before it stopped.
 */
export async function raiseRecovery(
  personId: string, companyId: string, within: RecoveryWithin, onStep?: (step: number, steps: number) => void, now: () => number = Date.now,
): Promise<RecoveryActed> {
  try {
    const seconds = RECOVERY_WITHIN.find((w) => w.id === within)?.seconds;
    if (seconds === undefined) return refused(ACT_REFUSAL.didNotFinish);
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    const ended = await raiseRecoveryInTheWallet({ ...named, latest: recoveryLatestAt(now(), seconds) }, ACCOUNT_ORIGIN, onStepOf(onStep));
    return await actedOf(RECOVERY_ACT.raise, ended, named, null);
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/** Ask the person's wallet to approve this recovery, and to carry it out in the same window if the approval is the last the account needs. */
export async function approveRecovery(
  personId: string, companyId: string, held: RecoveryHere, onStep?: (step: number, steps: number) => void,
): Promise<RecoveryActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    if (!isThisCompanys(held, named)) return refused(ACT_REFUSAL.didNotFinish);
    const ended = await approveRecoveryInTheWallet({ ...named, parts: held.parts }, ACCOUNT_ORIGIN, onStepOf(onStep));
    return await actedOf(RECOVERY_ACT.approve, ended, named, held);
  } catch (e) {
    return refused(refusalOf(e));
  }
}

/** Ask the person's wallet to carry this recovery out, if the chain counts the approvals the account needs; short of them it sends nothing. */
export async function carryOutRecovery(
  personId: string, companyId: string, held: RecoveryHere, onStep?: (step: number, steps: number) => void,
): Promise<RecoveryActed> {
  try {
    const named = await namedBefore(personId, companyId);
    if (typeof named === 'string') return refused(named);
    if (!isThisCompanys(held, named)) return refused(ACT_REFUSAL.didNotFinish);
    const ended = await carryOutRecoveryInTheWallet({ ...named, parts: held.parts }, ACCOUNT_ORIGIN, onStepOf(onStep));
    return await actedOf(RECOVERY_ACT.carry, ended, named, held);
  } catch (e) {
    return refused(refusalOf(e));
  }
}

type RecoveryOpened =
  | { readonly of: typeof FILE_OPENED.opened; readonly held: RecoveryHere }
  | { readonly of: typeof FILE_OPENED.refused; readonly why: FileRefusal };

const notOpened = (why: FileRefusal): RecoveryOpened => ({ of: FILE_OPENED.refused, why });

/** The recovery a saved file holds, when it is a recovery of this company. Nothing in the file is believed: its standing is read from the chain. */
export async function openRecoveryFile(companyId: string, text: string): Promise<RecoveryOpened> {
  try {
    const read = recoveryPartsInFile(text);
    if (read.parts === undefined) return notOpened(read.why);
    const named = await namedFor(companyId);
    if (named === null) return notOpened(FILE_REFUSED.companyUnread);
    const { parts } = read;
    if (parts.company !== companyId || parts.account.toLowerCase() !== named.account.toLowerCase()) return notOpened(FILE_REFUSED.notThisCompany);
    const held = heldFrom(parts);
    return held === null ? notOpened(FILE_REFUSED.unreadable) : { of: FILE_OPENED.opened, held };
  } catch {
    return notOpened(FILE_REFUSED.unreadable);
  }
}

/** Where the chain holds a recovery, as the account's own history shows it. */
export type RecoveryStanding =
  | {
    readonly of: typeof STANDING_READ.read; readonly held: HeldOnChain; readonly approvals: number; readonly needed: number | null;
    readonly outrun: boolean; readonly passed: boolean;
  }
  | { readonly of: typeof STANDING_READ.unread };

const unread: RecoveryStanding = { of: STANDING_READ.unread };

/**
 * Where the chain holds this recovery now: open, with the approvals it counts and the number its hold asked for when it was raised, or
 * no longer open, or never raised; and whether the last moment to carry it out has passed. Never throws; what cannot be read is `unread`.
 * The number the account asks for now can be higher than its hold's (the wallet works that out when it carries the recovery out).
 */
export async function recoveryStanding(companyId: string, held: RecoveryHere, now: () => number = Date.now): Promise<RecoveryStanding> {
  try {
    const named = await namedFor(companyId);
    if (named === null) return unread;
    const indexer = await walletIndexerFor(named.company as CompanyLabel, named.account as AccountAddress);
    if (indexer === null) return unread;
    const id = held.parts.chainId.toLowerCase();
    const round = (await (await theVaultBuilder()).roundsOnChain({ account: named.account, indexer, chainIds: [id] }))[id];
    if (round === undefined) return unread;
    return {
      of: STANDING_READ.read, held: round.held, approvals: round.approvals, needed: round.needed ?? null, outrun: round.outrun === true,
      passed: recoveryTimePassed(held.parts, now()),
    };
  } catch {
    return unread;
  }
}

/** Save a recovery's file to the person's disk, under the name it carries, with `summary` in it for whoever reads it. */
export const saveRecoveryFile = (held: RecoveryHere, summary: string): void => saveFileText(held.fileName, recoveryFileTextOf(held.parts, summary));


/**
 * Where the company's records stand on this device, as the recovery page tells it: the batch this device checked up to, a stop in the
 * records (a batch not given, or not honest, with the seat that moved the anchor past it where the stop names one), where the check
 * began when not from the first batch, what a recovery of the company's signers gave up, the versions of the directory the records
 * passed over, the changes filed again and not applied, and how many records are filed and not yet anchored.
 */
export interface RecordsStates {
  readonly reached: number;
  readonly stopped: TransitionStop | null;
  readonly checkedFrom: StartedFrom | null;
  readonly recovered: { readonly resumedFrom: number; readonly gaveUpTo: number } | null;
  readonly notYetAnchored: number;
  readonly passedOver: readonly number[];
  readonly notApplied: readonly number[];
}

/**
 * Read the company's records afresh with the reader that tells a stop as a state. A read that cannot be made at all (the wallet's
 * indexer behind what this device already checked, the service not giving a record the records name, the keys not open here) is
 * `unreadable`, and says nothing of why. Never throws.
 */
export async function readRecordsStates(personId: string, companyId: string): Promise<Read<RecordsStates>> {
  try {
    if (!(await keyringFor(personId))) return { of: READ.unreadable };
    const sealed = await api(SERVICE.company + companyId) as SealedAccount;
    const label = sealed.companyLabel ?? null;
    const address = sealed.contractAddress ?? null;
    const keys = await keysOnTheWayIn(companyId);
    if (label === null || address === null || keys === null) return { of: READ.unreadable };
    const account = await openedHere(sealed);
    if (account === null) return { of: READ.unreadable };
    const viewingKey = await companyKeysFor(companyId, sealed, { signingPublicKey: keys.signingPublicKey });
    const here = await directoryWithItsRecordsFor(companyId, label as CompanyLabel, address as AccountAddress, viewingKey, async () => account)({});
    const records = here.records as RecordsHeldHere;
    return {
      of: READ.read,
      value: {
        reached: records.reached.seq, stopped: records.stopped, checkedFrom: records.checkedFrom ?? null,
        recovered: records.recovered === undefined ? null : { resumedFrom: records.recovered.resumedFrom.seq, gaveUpTo: records.recovered.gaveUpTo },
        notYetAnchored: records.notYetAnchored.length, passedOver: (here.passedOver ?? []).map((f) => f.version),
        notApplied: (here.refiledRefused ?? []).map((r) => r.version),
      },
    };
  } catch {
    return { of: READ.unreadable };
  }
}

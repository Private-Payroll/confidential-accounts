/**
 * **GOVERNANCE WHILE THE COMPANY'S RECORDS ARE STOPPED: A PROPOSAL READ FROM
 * THE CHAIN AND FROM A FILE, NEVER FROM THE COMPANY'S SERVICE**.
 *
 * Governance through the company's records (`governOnDevice`) opens every
 * proposal from the records the one check believes, so it cannot run while
 * that check is stopped, or while the service is gone. This is the other way
 * through, and the general one: the seat raising a change hands its details
 * to the other signers as a file (`ProposalFile`); each signer's device
 * checks the file against the chain, at the indexer the person's own wallet
 * names - the proposal's identity remade here from the change and its salt,
 * and that proposal open on the account now - and against the change's own
 * check, which the caller gives; and every call is built on the account's
 * state read at that same indexer. A call is sent through the company's
 * service, which pays its fee, and is believed sent only once the chain at that
 * indexer shows it; where the service is gone, refuses it, or says it sent it
 * and the chain does not show it in time, the person is told and chooses
 * whether their own wallet sends it, and pays. Nothing here reads the
 * company's service. A recovery of the record anchor is built on it
 * (`records-recovered-here.ts`), and a removal can be built on it the same way.
 *
 * A change of the super admins is one more kind of proposal here, raised,
 * approved from a file and finished by the same functions, and never a
 * proposal on the account: the super admins' approvals are their wallets'
 * signatures on each contract's maintenance update, counted only where they
 * verify under that contract's committee on the chain, and nothing of it is
 * held open on the account, read from the signers or counted toward theirs.
 */
import { commit } from '../../../src/core/crypto.js';
import { raiseByOf } from '../../../src/core/proposal-filing.js';
import { assetIdHex, NO_ASSET } from '../../../src/core/assets.js';
import type { ResumesFrom } from '../../../src/midnight/record-tree.js';
import type {
  AccountCallChainOnTheWire, VaultBuilderClient,
} from './vault-worker-client.js';
import type { GovernanceOnTheWire, OpenedRound, RoundOnChain, SignerMaterial } from './governed-call-builder.js';
import { sameGovernance } from './governance-compared.js';
import { ApprovalNotOwed } from './governed-call-on-device.js';
import { PROPOSAL_FILE_FORMAT, proposalFileRefusal, type ProposalFile } from './proposal-file.js';
import {
  approveSuperAdminChange, isSuperAdminFile, raiseSuperAdminChange,
  type SuperAdminChangeApproved, type SuperAdminChangeRaised, type SuperAdminDoors, type SuperAdminsAskedFor,
} from './super-admin-change.js';
import { LANDED_WITHIN_MS, watchedOnTheChain } from './watched-on-the-chain.js';

/* The proposal file and the change of the super admins live in files of their own; every name they had here is still read from here. */
export * from './proposal-file.js';
export {
  joinFromAFile, joiningKeys, resumeFromAFile,
  type SuperAdminChangeApproved, type SuperAdminChangeProgress, type SuperAdminChangeRaised, type SuperAdminContractStanding,
  type SuperAdminDoors, type SuperAdminsAskedFor,
} from './super-admin-change.js';


/** What a proposal read from the chain and from a file asks of this device. */
export interface FromTheChainDoors {
  /** The company, as its records name it. */
  readonly accountId: string;
  /** The company's account on chain, as the person's own wallet reads who holds it. */
  readonly account: string;
  /** This signer's own three, from the keyring this device opened. */
  readonly material: SignerMaterial;
  /** The indexer the person's own wallet names: the one place the chain is read. */
  readonly indexer: { readonly indexerUri: string; readonly indexerWsUri: string };
  readonly builder: Pick<VaultBuilderClient, 'proposalIdentity' | 'governedCall' | 'roundsOnChain' | 'accountCallChain'>;
  /**
   * How a call this device proved is sent: through the company's service,
   * which pays its fee; where that is absent, refuses, or says it sent a call
   * the chain does not show in time, through the person's own wallet, which
   * pays it - only once the person, told why, chooses it (`chosen`). A wallet
   * that asks the service nothing leaves `service` out, and answers `chosen`
   * with the choice the person already made in its window.
   */
  readonly send: {
    readonly service?: (tx: string) => Promise<unknown>;
    readonly ownWallet?: {
      readonly send: (tx: string) => Promise<unknown>;
      /** Asks the person, in these words, whether their own wallet sends the call and pays its fee; true when they choose it. */
      readonly chosen: (why: string) => Promise<boolean>;
    };
  };
  /** How a call sent is watched for on the chain: every `everyMs`, for `withinMs` (`LANDED_EVERY_MS`, `LANDED_WITHIN_MS`). */
  readonly watch?: { readonly everyMs?: number; readonly withinMs?: number; readonly sleep?: (ms: number) => Promise<void> };
  readonly random?: (n: number) => Uint8Array;
}

/** Which way a call went: through the company's service, or through the person's own wallet. */
export type SentBy = 'service' | 'own-wallet';


/** The wait, as it is said to the person. */
const withinSaid = (ms: number): string => {
  const [n, unit] = ms % 60_000 === 0 ? [ms / 60_000, 'minute'] : [Math.ceil(ms / 1000), 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};


/**
 * **A CALL THIS DEVICE PROVED, SENT, AND BELIEVED SENT ONLY WHEN THE CHAIN SHOWS
 * IT**: through the company's service, watched for at the indexer the person's
 * own wallet names from the moment it is handed over (`went`: what the chain
 * shows of it, null while it shows nothing), never waiting on the service's
 * answer. Where the service is absent (not reachable, or not asked), refuses it, does not answer, or says it
 * sent it, and the chain does not show it in time, the person is told why and
 * chooses whether their own wallet sends it, and pays; declined, nothing more
 * is sent. So a service answering "sent" can never stop the call. Refused, in
 * words that say what to do, when no way sends it.
 */
export async function sentFromHere<T>(
  doors: Pick<FromTheChainDoors, 'send' | 'watch'>, tx: string, went: () => Promise<T | null>,
): Promise<{ readonly sentBy: SentBy; readonly went: T }> {
  const withinMs = doors.watch?.withinMs ?? LANDED_WITHIN_MS;
  let why: string;
  if (doors.send.service === undefined) {
    why = 'the company\'s service is not asked to send this call';
  } else {
    /* The service's answer is never waited on: a service that never answers stops nothing. */
    let answered = false;
    let serviceSaid: string | null = null;
    let handed: Promise<unknown>;
    try { handed = doors.send.service(tx); } catch (e) { handed = Promise.reject(e); }
    void handed.then(
      () => { answered = true; },
      (e: unknown) => { answered = true; serviceSaid = (e as Error)?.message ?? String(e); },
    );
    const seen = await watchedOnTheChain(doors, went, () => serviceSaid !== null);
    if (seen !== null) return { sentBy: 'service', went: seen };
    why = serviceSaid !== null
      ? `the company's service did not send the call (${serviceSaid})`
      : answered
        ? `the company's service said it sent the call, but the chain, as your wallet's indexer shows it, did not show it within ${withinSaid(withinMs)}`
        : `the company's service did not answer within ${withinSaid(withinMs)}, and the chain, as your wallet's indexer shows it, does not show the call`;
  }
  const own = doors.send.ownWallet;
  if (own === undefined) throw new Error(`${why}, and no wallet is connected to send it instead. Connect your wallet, then try again`);
  if (!(await own.chosen(`${why}. Your own wallet can send it instead, and pay its fee`))) {
    throw new Error(`${why}, and you chose not to send it from your own wallet, so nothing more was sent. `
      + 'Try again later, or send it from your own wallet');
  }
  try {
    await own.send(tx);
  } catch (e) {
    throw new Error(`${why}, and your wallet did not send it either (${(e as Error)?.message ?? String(e)}). `
      + 'Check that your wallet holds enough to pay the fee, then try again');
  }
  const seen = await watchedOnTheChain(doors, went);
  if (seen === null) {
    throw new Error(`your wallet sent the call, but the chain, as your wallet's indexer shows it, did not show it within ${withinSaid(withinMs)}. `
      + 'Wait a few minutes and read the company again before sending anything again');
  }
  return { sentBy: 'own-wallet', went: seen };
}

/** What a call to the account alone is built on, read at the indexer the person's own wallet names, and never from the company's service. */
export async function callStateHere(doors: Pick<FromTheChainDoors, 'account' | 'indexer' | 'builder'>): Promise<AccountCallChainOnTheWire & { readonly account: string }> {
  const chain = await doors.builder.accountCallChain({ account: doors.account, indexer: doors.indexer });
  if (chain === null) {
    throw new Error('the indexer your wallet names does not hold the company\'s account yet. Wait for your wallet to catch up, then try again');
  }
  return { ...chain, account: doors.account };
}

/**
 * Where a proposal stands, read from the account's history at the indexer the person's own wallet names. With `seat`,
 * this device's signing secret, it also says whether the chain holds that seat's approval of it (`approvedHere`).
 */
async function standingOnTheChain(
  doors: Pick<FromTheChainDoors, 'account' | 'indexer' | 'builder'>, chainId: string, seat?: string,
): Promise<RoundOnChain> {
  const rounds = await doors.builder.roundsOnChain({
    account: doors.account, indexer: doors.indexer, chainIds: [chainId], ...(seat === undefined ? {} : { seat }),
  });
  return rounds[chainId.toLowerCase()] ?? { held: 'never', approvals: 0 };
}

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * The deadline a raise from the chain carries, as no record of it is written down: a recovery's own last time to be
 * carried out, past which it is void, and for any other change a day from now (`RAISE_WINDOW_SECONDS`).
 */
const raiseByFromTheChain = (change: GovernanceOnTheWire): string => (change.kind === 'recover-anchor'
  ? change.latest : raiseByOf(new Date().toISOString()));

/** The proposal as this device makes it again from the change and its salt, with the account's own functions. */
async function openedFrom(doors: Pick<FromTheChainDoors, 'builder'>, change: GovernanceOnTheWire, salt: string, summary: string): Promise<OpenedRound> {
  const identity = await doors.builder.proposalIdentity(change, salt);
  return {
    chainId: identity.chainId, digest: identity.digest, vault: identity.noVault, salt, summary, governance: change,
    half: { assetId: assetIdHex(NO_ASSET), changeAmount: '0', changeBatchDigest: commit('', '') },
  };
}

/**
 * **A GOVERNANCE CHANGE RAISED FROM THIS DEVICE WITHOUT THE COMPANY'S RECORDS**:
 * its salt made here, its identity made with the account's own functions, its
 * raise built on the account's state at the wallet's indexer and sent
 * (`sentFromHere`); the file to hand to the other signers is returned. The
 * account's half of a governance raise names no currency and no amount and is
 * never opened, so its blinding is made here.
 */
export async function raiseFromTheChain(
  doors: FromTheChainDoors,
  input: { readonly change: GovernanceOnTheWire; readonly summary: string; readonly resumesFrom?: ResumesFrom },
): Promise<{ readonly file: ProposalFile; readonly sentBy: SentBy }>;
export async function raiseFromTheChain(doors: SuperAdminDoors, input: SuperAdminsAskedFor): Promise<SuperAdminChangeRaised>;
export async function raiseFromTheChain(
  doors: FromTheChainDoors | SuperAdminDoors,
  input: { readonly change: GovernanceOnTheWire; readonly summary: string; readonly resumesFrom?: ResumesFrom } | SuperAdminsAskedFor,
): Promise<{ readonly file: ProposalFile; readonly sentBy: SentBy } | SuperAdminChangeRaised> {
  if (input.change.kind === 'super-admins') return raiseSuperAdminChange(superAdminDoorsOf(doors), input as SuperAdminsAskedFor);
  return raiseSignersProposal(signersDoorsOf(doors), input as { readonly change: GovernanceOnTheWire; readonly summary: string; readonly resumesFrom?: ResumesFrom });
}

async function raiseSignersProposal(
  doors: FromTheChainDoors,
  input: { readonly change: GovernanceOnTheWire; readonly summary: string; readonly resumesFrom?: ResumesFrom },
): Promise<{ readonly file: ProposalFile; readonly sentBy: SentBy }> {
  const random = doors.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const salt = hexOf(random(32));
  const opened = { ...await openedFrom(doors, input.change, salt, input.summary), raiseBy: raiseByFromTheChain(input.change) };
  const file: ProposalFile = {
    format: PROPOSAL_FILE_FORMAT, company: doors.accountId, account: doors.account.toLowerCase(), change: input.change, salt,
    chainId: opened.chainId.toLowerCase(), summary: input.summary, ...(input.resumesFrom === undefined ? {} : { resumesFrom: input.resumesFrom }),
  };
  const why = proposalFileRefusal(file);
  if (why !== null) throw new Error(`${why}. Nothing was sent`);
  const chain = await callStateHere(doors);
  const { tx } = await doors.builder.governedCall({
    account: chain.account, material: doors.material, chain, opened,
    order: {
      circuit: 'propose', governance: input.change, proposal: opened.chainId,
      half: { assetId: opened.half!.assetId, assetBlinding: hexOf(random(32)), proposalSalt: salt, changeAmount: '0', changeBatchDigest: opened.half!.changeBatchDigest },
    },
  });
  /* Sent when the chain holds the proposal: open, or already acted on. */
  const { sentBy } = await sentFromHere(doors, tx, async () => ((await standingOnTheChain(doors, file.chainId)).held === 'never' ? null : true));
  return { file, sentBy };
}

/**
 * **WHY THIS FILE'S PROPOSAL IS NOT ONE THIS DEVICE MAY ACT ON NOW, OR NULL**:
 * a file for another company or account, an identity the change and its salt
 * do not make, or a proposal the chain does not hold open.
 */
async function fileAgainstTheChain(doors: FromTheChainDoors, file: ProposalFile): Promise<{ opened: OpenedRound; standing: RoundOnChain }> {
  const why = proposalFileRefusal(file);
  if (why !== null) throw new Error(`${why}. Nothing was built or sent`);
  if (file.change.kind === 'super-admins') throw new Error(`${NOT_A_SIGNERS_PROPOSAL}. Nothing was built or sent`);
  if (file.company !== doors.accountId || file.account.toLowerCase() !== doors.account.toLowerCase()) {
    throw new Error('this file is for another company than the one open on this page. Nothing was built or sent. Open the company the file names, then open the file there');
  }
  const opened = await openedFrom(doors, file.change, file.salt, file.summary);
  if (opened.chainId.toLowerCase() !== file.chainId.toLowerCase() || !sameGovernance(opened.governance!, file.change)) {
    throw new Error('the change and the salt in this file make another proposal than the one it names. Nothing was built or sent. Do not approve it; ask the signer who raised it');
  }
  const standing = await standingOnTheChain(doors, file.chainId);
  if (standing.held !== 'open') {
    throw new Error(standing.held === 'never'
      ? 'the chain, as your wallet\'s indexer shows it, does not hold this proposal: it was never raised, or has not reached the indexer yet. Nothing was built or sent. Wait a minute, then try again'
      : 'the chain no longer holds this proposal open: it was carried out or withdrawn. Nothing was built or sent');
  }
  return { opened, standing };
}

/**
 * **A FILE'S PROPOSAL APPROVED FROM THIS DEVICE**: checked against the chain
 * (`fileAgainstTheChain`) and against the change's own check (`check`, which
 * throws in words that say why), its approval built on the account's state at
 * the wallet's indexer, bound to the change and its salt, and sent. When the chain already holds this seat's approval
 * of it (its own approval, or its raise counted as its approval), it is refused as `ApprovalNotOwed('counted')` with
 * nothing built or sent.
 */
export async function approveFromAFile(
  doors: FromTheChainDoors, file: ProposalFile, check: (file: ProposalFile) => Promise<void>,
): Promise<{ readonly sentBy: SentBy; readonly approvalsBefore: number }>;
export async function approveFromAFile(doors: SuperAdminDoors, file: ProposalFile): Promise<SuperAdminChangeApproved>;
export async function approveFromAFile(
  doors: FromTheChainDoors | SuperAdminDoors, file: ProposalFile, check?: (file: ProposalFile) => Promise<void>,
): Promise<{ readonly sentBy: SentBy; readonly approvalsBefore: number } | SuperAdminChangeApproved> {
  if (isSuperAdminFile(file)) return approveSuperAdminChange(superAdminDoorsOf(doors), file);
  if (check === undefined) throw new Error('this proposal has no check of its own to be approved with. Nothing was built or sent');
  return approveSignersProposal(signersDoorsOf(doors), file, check);
}

async function approveSignersProposal(
  doors: FromTheChainDoors, file: ProposalFile, check: (file: ProposalFile) => Promise<void>,
): Promise<{ readonly sentBy: SentBy; readonly approvalsBefore: number }> {
  const { opened, standing } = await fileAgainstTheChain(doors, file);
  await check(file);
  /* Whether this seat's approval is already counted is the chain's answer, read for this seat, before anything is built. */
  const seat = doors.material.signingSecret;
  const mine = await standingOnTheChain(doors, file.chainId, seat);
  if (mine.approvedHere === undefined) {
    throw new Error('whether your approval of this proposal is already counted was not read from the chain, so nothing was built or sent. '
      + 'Reload the page and try again');
  }
  if (mine.approvedHere) throw new ApprovalNotOwed('counted');
  const chain = await callStateHere(doors);
  const { tx } = await doors.builder.governedCall({
    account: chain.account, material: doors.material, chain, opened,
    order: { circuit: 'approve', proposal: opened.chainId, of: { governance: file.change as GovernanceOnTheWire, proposalSalt: file.salt } },
  });
  /* Sent when the chain holds this seat's own approval, never a count another seat's approval can also raise, or no longer holds the proposal open. */
  const { sentBy } = await sentFromHere(doors, tx, async () => {
    const now = await standingOnTheChain(doors, file.chainId, seat);
    return now.held !== 'open' || now.approvedHere === true ? true : null;
  });
  return { sentBy, approvalsBefore: standing.approvals };
}

/** A file's proposal, checked against the chain, for a carrying out the caller builds: what it is, and where it stands. */
export const fileCheckedAgainstTheChain = fileAgainstTheChain;

/** Where a file's proposal stands now, at the indexer the person's own wallet names. */
export const standingNow = standingOnTheChain;

/* ── A CHANGE OF THE SUPER ADMINS ─────────────────────────────────────────── */

/** Said when a change of the super admins reaches a step that only a signers' proposal takes, or the reverse. */
const NOT_A_SIGNERS_PROPOSAL = 'this is a change of the super admins, which is approved with each super admin\'s own wallet and never '
  + 'held open, approved or counted on the company\'s account as a signers\' proposal';


function superAdminDoorsOf(doors: FromTheChainDoors | SuperAdminDoors): SuperAdminDoors {
  if (!('wallet' in doors) || !('ledger' in doors)) throw new Error(`${NOT_A_SIGNERS_PROPOSAL}. Nothing was built or sent`);
  return doors;
}

function signersDoorsOf(doors: FromTheChainDoors | SuperAdminDoors): FromTheChainDoors {
  if (!('material' in doors) || !('builder' in doors)) {
    throw new Error('this is a signers\' proposal, which a signer\'s own keys raise and approve on the company\'s account; a super admin\'s wallet '
      + 'alone never does. Nothing was built or sent');
  }
  return doors;
}


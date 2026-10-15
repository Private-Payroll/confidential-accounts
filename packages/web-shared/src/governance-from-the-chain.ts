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
import { assetIdHex, NO_ASSET } from '../../../src/core/assets.js';
import type { ResumesFrom } from '../../../src/midnight/record-tree.js';
import type {
  AccountCallChainOnTheWire, VaultBuilderClient,
} from './vault-worker-client.js';
import type { GovernanceOnTheWire, OpenedRound, RoundOnChain, SignerMaterial } from './governed-call-builder.js';
import { sameGovernance } from './governance-compared.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { whyNotInstallable, type SuperAdminChangeOnTheWire } from 'midnight-identity/profile/request';
import { joinedBy, superAdminChangeBytes } from 'midnight-identity/profile/committee-sign';
import { readAccountAddress, readCompanyLabel, type AccountAddress, type CompanyLabel } from 'midnight-identity/profile/company-label';
import type { ContractAuthority } from 'midnight-identity/profile/contract-authority';
import { committeeReplacement, sameCommittee, type ReplacementPrimitives } from '../../../src/midnight/vault-committee.js';
import {
  authorityHere, committeeWarning, superAdminsHere, superAdminsSeenHere,
  type SuperAdminChangeInProgress, type SuperAdminsSeen,
} from './committee-here.js';
import type { VaultChainSource } from './vault-on-chain-here.js';

/** What names a proposal file, so a file of any other kind is never read as one. */
export const PROPOSAL_FILE_FORMAT = 'confidential-accounts/proposal-file/v1';

/**
 * **A GOVERNANCE PROPOSAL, AS ITS RAISER HANDS IT TO THE OTHER SIGNERS**: the
 * company and its account, the change and the salt the proposal was raised
 * with, its identity on chain, the words the person is shown, and what the
 * change's own check reads beside it - for a recovery of the record anchor,
 * the header it resumes from. A recovery's change also names the head the
 * latest recovery carried out wrote, which the approvals bind. Nothing in it is believed: the identity is made
 * again from the change and the salt, and the chain must hold it open.
 */
export interface ProposalFile {
  readonly format: typeof PROPOSAL_FILE_FORMAT;
  /** The company as its records name it; for a change of the super admins, the company's label, which wallets derive their keys from. */
  readonly company: string;
  readonly account: string;
  readonly change: GovernanceOnTheWire | SuperAdminChangeOnTheWire;
  readonly salt: string;
  readonly chainId: string;
  readonly summary: string;
  /** A recovery's: the header it resumes from, whose head its change names; the change also names the last time it may be carried out. */
  readonly resumesFrom?: ResumesFrom;
  /** A change of the super admins only: each joining key's signature over the change, made with that key. */
  readonly joined?: readonly JoiningSignature[];
  /** A change of the super admins only: the wallets' signatures on each contract's maintenance update, as collected so far. */
  readonly signatures?: readonly SuperAdminSignature[];
}

type Key = { readonly tag: string; readonly value: string };

/** A joining key's own signature over the change's bytes: proof that somebody holds the key before it is put on any contract. */
export interface JoiningSignature { readonly key: Key; readonly signature: string }

/** One wallet's signature on one contract's maintenance update, at one place on the committee holding that contract. */
export interface SuperAdminSignature {
  readonly address: string;
  /** The contract's counter it was signed at, in decimal. */
  readonly counter: string;
  /** The place on the contract's committee whose key made it. */
  readonly index: number;
  readonly signature: Key;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const KINDS = new Set(['add-signer', 'threshold', 'vault-threshold', 'spending-policy', 'policy-bar', 'recover-anchor', 'super-admins']);
const HEX = /^[0-9a-f]+$/u;
const HEX128 = /^[0-9a-f]{128}$/u;
const DIGITS = /^[0-9]{1,20}$/u;

/**
 * **WHY THIS IS NOT A PROPOSAL FILE THIS DEVICE CAN READ, OR NULL WHEN IT IS.**
 * Read before anything of it is used; every value is checked again against the
 * chain before anything is built.
 */
function proposalFileRefusal(f: unknown): string | null {
  const x = f as Partial<ProposalFile> | null;
  if (typeof x !== 'object' || x === null || x.format !== PROPOSAL_FILE_FORMAT) {
    return 'this file is not a proposal handed over by a signer of a company. Ask the signer who raised it to send the file again';
  }
  if (typeof x.company !== 'string' || x.company.length === 0) return 'the file names no company. Ask the signer who raised it to send it again';
  for (const [name, v] of [['account', x.account], ['salt', x.salt], ['identity', x.chainId]] as const) {
    if (typeof v !== 'string' || !HEX64.test(v)) return `the proposal's ${name} in the file is not thirty-two bytes. Ask the signer who raised it to send it again`;
  }
  if (typeof x.summary !== 'string') return 'the file says nothing of what the proposal changes. Ask the signer who raised it to send it again';
  const change = x.change as { kind?: unknown } | undefined;
  if (typeof change !== 'object' || change === null || !KINDS.has(String(change.kind))) {
    return 'the file names a change this page does not carry out. Reload the page to use the current version, then open the file again';
  }
  const superAdmins = change.kind === 'super-admins';
  if (!superAdmins && (x.joined !== undefined || x.signatures !== undefined)) {
    return 'the file carries super admins\' signatures on a signers\' proposal, which never carries or counts them. Do not approve it; ask the signer who raised it';
  }
  if (superAdmins) return superAdminFileRefusal(x);
  if (change.kind === 'recover-anchor') {
    const r = x.resumesFrom as Partial<ResumesFrom> | undefined;
    const head = (change as { resumesFrom?: unknown }).resumesFrom;
    if (r === undefined || !Number.isSafeInteger(r.seq) || r.seq! < 0 || typeof r.head !== 'string' || !HEX64.test(r.head)
      || typeof r.root !== 'string' || !HEX64.test(r.root)) {
      return 'the file does not say which batch of the company\'s records the recovery resumes from. Ask the signer who raised it to send it again';
    }
    if (typeof head !== 'string' || head !== r.head) {
      return 'the batch the file says the recovery resumes from is not the one its change names. Do not approve it; ask the signer who raised it';
    }
    const latest = (change as { latest?: unknown }).latest;
    if (typeof latest !== 'string' || !/^[1-9][0-9]*$/u.test(latest)) {
      return 'the file does not say until when the recovery may be carried out. Ask the signer who raised it to send it again';
    }
    const lastRecovery = (change as { lastRecovery?: unknown }).lastRecovery;
    if (typeof lastRecovery !== 'string' || !HEX64.test(lastRecovery)) {
      return 'the file does not say which recovery of the company\'s records was the latest carried out when it was raised. '
        + 'Ask the signer who raised it to send it again';
    }
  }
  return null;
}

/** The file's text, as a signer saves and sends it. */
export const proposalFileText = (f: ProposalFile): string => `${JSON.stringify(f, null, 2)}\n`;

/** A proposal file read from its text, or refused in words that say what to do (`proposalFileRefusal`). */
export function proposalFileRead(text: string): ProposalFile {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new Error('this file could not be read as a proposal. Ask the signer who raised it to send the file again');
  }
  const why = proposalFileRefusal(parsed);
  if (why !== null) throw new Error(why);
  return parsed as ProposalFile;
}

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
   * pays it - only once the person, told why, chooses it (`chosen`).
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

/** How long a call sent is waited for on the chain before it is said not to have landed: two minutes, about twenty blocks. */
const LANDED_WITHIN_MS = 2 * 60 * 1000;
/** How often the chain is read while a call sent is waited for. */
const LANDED_EVERY_MS = 5 * 1000;

/** The wait, as it is said to the person. */
const withinSaid = (ms: number): string => {
  const [n, unit] = ms % 60_000 === 0 ? [ms / 60_000, 'minute'] : [Math.ceil(ms / 1000), 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};

/**
 * **WHAT THE CHAIN SHOWS OF A CALL SENT, WAITED FOR**: `went` read at the
 * indexer the person's own wallet names, at once and then every `everyMs`
 * until it answers or `withinMs` has passed - or, once `over` says there is
 * nothing more to wait for, after one more read; null when it never answered.
 */
async function watchedOnTheChain<T>(
  doors: Pick<FromTheChainDoors, 'watch'>, went: () => Promise<T | null>, over: () => boolean = () => false,
): Promise<T | null> {
  const everyMs = doors.watch?.everyMs ?? LANDED_EVERY_MS;
  const withinMs = doors.watch?.withinMs ?? LANDED_WITHIN_MS;
  const sleep = doors.watch?.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));
  for (let waited = 0; ; waited += everyMs) {
    const seen = await went();
    if (seen !== null) return seen;
    if (waited >= withinMs || over()) return null;
    await sleep(everyMs);
  }
}

/**
 * **A CALL THIS DEVICE PROVED, SENT, AND BELIEVED SENT ONLY WHEN THE CHAIN SHOWS
 * IT**: through the company's service, watched for at the indexer the person's
 * own wallet names from the moment it is handed over (`went`: what the chain
 * shows of it, null while it shows nothing), never waiting on the service's
 * answer. Where the service is absent, refuses it, does not answer, or says it
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
    why = 'the company\'s service is not reachable from this page';
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

/** Where a proposal stands, read from the account's history at the indexer the person's own wallet names. */
async function standingOnTheChain(doors: Pick<FromTheChainDoors, 'account' | 'indexer' | 'builder'>, chainId: string): Promise<RoundOnChain> {
  const rounds = await doors.builder.roundsOnChain({ account: doors.account, indexer: doors.indexer, chainIds: [chainId] });
  return rounds[chainId.toLowerCase()] ?? { held: 'never', approvals: 0 };
}

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

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
  const opened = await openedFrom(doors, input.change, salt, input.summary);
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
 * the wallet's indexer, bound to the change and its salt, and sent.
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
  const chain = await callStateHere(doors);
  const { tx } = await doors.builder.governedCall({
    account: chain.account, material: doors.material, chain, opened,
    order: { circuit: 'approve', proposal: opened.chainId, of: { governance: file.change as GovernanceOnTheWire, proposalSalt: file.salt } },
  });
  /* Sent when the chain counts one more approval than before it, or no longer holds the proposal open. */
  const { sentBy } = await sentFromHere(doors, tx, async () => {
    const now = await standingOnTheChain(doors, file.chainId);
    return now.held !== 'open' || now.approvals > standing.approvals ? true : null;
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

/** What the person asks to change: the committee every contract of the company is to hold, in order, and its threshold. */
export interface SuperAdminsAskedFor {
  readonly change: { readonly kind: 'super-admins'; readonly committee: readonly Key[]; readonly threshold: number };
  /** The company's label, which every wallet derives its key for the company from. */
  readonly company: string;
  /** The company's account, by its address. */
  readonly account: string;
  readonly summary: string;
}

/**
 * **WHAT A CHANGE OF THE SUPER ADMINS ASKS OF THIS DEVICE.** Every fact is read
 * at the indexer the person's own wallet names (`chain`) or asked of their own
 * wallet; the company's service is only a way to send, and to fetch
 * signatures each device checks for itself. Nothing here needs a seat in the
 * company, its records or a sign-in with its service.
 */
export interface SuperAdminDoors {
  /** The runtime's state reader and the account's compiled reader, as `superAdminsHere` takes them. */
  readonly readers: Parameters<typeof superAdminsHere>[0];
  /** The chain, read at the indexer the person's own wallet names. */
  readonly chain: Pick<VaultChainSource, 'contractState'>;
  /** The ledger's classes, to make the very bytes each contract's update is signed over, and its signature check. */
  readonly ledger: ReplacementPrimitives & { verifySignature(key: never, data: Uint8Array, signature: never): boolean };
  /** Every vault the company's own records say it created, where this device holds those records; empty where it does not. */
  readonly createdByTheCompany: readonly string[];
  /** The seats this device believes, to name a committee key beside the seat whose opening proves it; empty where it holds none. */
  readonly seats: Parameters<typeof superAdminsSeenHere>[2]['seats'];
  readonly wallet: {
    /** This person's key for the company, as their own wallet gives it. */
    readonly key: (company: { readonly company: CompanyLabel; readonly account: AccountAddress }) => Promise<Key>;
    /**
     * One press: the wallet signs the update of every contract named, at its
     * counter, at each place its key holds. Asked only once every key the
     * change adds has signed it. The ask carries the change whole and its
     * salt, from which the wallet rebuilds the bytes (`superAdminChangeBytes`)
     * and compares them with `bytes`; and `joined`, every joining key's
     * signature over them, which the wallet checks against the joins it works
     * out from each contract's committee as it reads the chain itself. Who
     * holds each contract is never sent: the wallet reads it.
     */
    readonly signUpdates: (ask: {
      readonly company: CompanyLabel; readonly account: AccountAddress;
      readonly salt: string; readonly change: SuperAdminChangeOnTheWire;
      readonly bytes: Uint8Array; readonly joined: readonly JoiningSignature[];
      readonly contracts: ReadonlyArray<{ readonly contract: 'account' | 'vault'; readonly address: string; readonly counter: string }>;
    }) => Promise<{ readonly signer: Key; readonly signatures: ReadonlyArray<{ readonly address: string; readonly counter: string; readonly seat: number; readonly signature: Key }> }>;
    /**
     * A joining key signs the change with its own key: the wallet rebuilds the
     * bytes from the change and its salt, compares them with `bytes`, and
     * shows who joins and leaves each contract as it reads the chain itself.
     */
    readonly signJoin: (ask: {
      readonly company: CompanyLabel; readonly account: AccountAddress;
      readonly salt: string; readonly change: SuperAdminChangeOnTheWire; readonly bytes: Uint8Array;
    }) => Promise<{ readonly signer: Key; readonly signature: string }>;
  };
  /**
   * The company's service: the one way a maintenance update is sent and paid
   * for today, and a place signatures may be fetched from. Whatever it says,
   * a send is believed only when the chain shows it, and a signature it hands
   * over counts only where it verifies. Each send carries the change whole,
   * its salt and every joining key's signature, so the service can refuse an
   * update whose joins are not all signed.
   */
  readonly service?: {
    readonly send: (update: {
      readonly address: string; readonly counter: string;
      readonly to: { readonly committee: readonly Key[]; readonly threshold: number };
      readonly signatures: ReadonlyArray<{ readonly index: number; readonly signature: Key }>;
      readonly change: {
        readonly company: string; readonly salt: string; readonly change: SuperAdminChangeOnTheWire;
        readonly joined: readonly JoiningSignature[];
      };
    }) => Promise<unknown>;
    readonly collected?: () => Promise<readonly SuperAdminSignature[]>;
  };
  readonly watch?: FromTheChainDoors['watch'];
  readonly random?: (n: number) => Uint8Array;
}

const isSuperAdminFile = (file: ProposalFile): boolean => (file.change as { kind?: unknown } | undefined)?.kind === 'super-admins';

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

const sameKey = (a: Key, b: Key): boolean => a.tag.toLowerCase() === b.tag.toLowerCase() && a.value.toLowerCase() === b.value.toLowerCase();
const keyAt = (keys: readonly Key[], k: Key): boolean => keys.some((x) => sameKey(x, k));

/** The change's identity: the hash of its bytes. */
const superAdminChangeId = (company: string, account: string, salt: string, change: SuperAdminChangeOnTheWire): string =>
  hexOf(sha256(superAdminChangeBytes(company, account, salt, change)));

/**
 * **THE KEYS A CHANGE OF THE SUPER ADMINS PUTS ON A CONTRACT**: every key of
 * the committee it installs that the committee holding some contract still to
 * move, as the chain holds it now, does not hold - in the installed order.
 * Read from the chain and never from the committee a file says it replaces,
 * so a stale or altered file cannot put a key on a contract unsigned.
 */
export const joiningKeys = (
  committee: readonly Key[], holders: ReadonlyArray<{ readonly committee: readonly Key[] }>,
): readonly Key[] => committee.filter((k) => holders.some((h) => !keyAt(h.committee, k)));

/** Why nothing goes further while joining keys are missing, in words for the person. */
const joinsHeld = (n: number): string => `${n} joining key${n === 1 ? ' has' : 's have'} not signed the change with ${n === 1 ? 'its' : 'their'} own key`;

/** Why this file's change of the super admins cannot be read, or null when its shape can. Nothing in it is believed yet. */
function superAdminFileRefusal(x: Partial<ProposalFile>): string | null {
  const c = x.change as Partial<SuperAdminChangeOnTheWire>;
  const ask = 'Ask the super admin who raised it to send it again';
  if (readCompanyLabel(x.company) === null) return `the file does not name the company by its label. ${ask}`;
  const keysOk = (keys: unknown): boolean => Array.isArray(keys) && keys.every((k) => typeof k === 'object' && k !== null
    && typeof (k as Key).tag === 'string' && typeof (k as Key).value === 'string' && HEX.test((k as Key).value));
  const from = c.from as Partial<SuperAdminChangeOnTheWire['from']> | undefined;
  if (typeof from !== 'object' || from === null || !keysOk(from.committee) || !Number.isSafeInteger(from.threshold)) {
    return `the file does not say who held the company's account when the change was raised. ${ask}`;
  }
  /* The one install rule every door that installs a committee asks. */
  const notInstallable = whyNotInstallable({ committee: c.committee, threshold: c.threshold });
  if (notInstallable !== null) return `the committee the file names cannot be installed: ${notInstallable}`;
  const contracts = c.contracts;
  if (!Array.isArray(contracts) || contracts.length === 0 || !contracts.every((k, i) => typeof k === 'object' && k !== null
    && (k.contract === 'account') === (i === 0 && k.address === x.account) && (k.contract === 'account' || k.contract === 'vault')
    && typeof k.address === 'string' && HEX64.test(k.address) && typeof k.counter === 'string' && DIGITS.test(k.counter))) {
    return `the file does not name each contract the change moves, the account first, with its counter. ${ask}`;
  }
  if (new Set(contracts.map((k) => k.address)).size !== contracts.length) return `the file names one contract twice. ${ask}`;
  if (x.joined !== undefined && (!Array.isArray(x.joined) || !x.joined.every((j) => typeof j === 'object' && j !== null
    && keysOk([j.key]) && typeof j.signature === 'string' && HEX128.test(j.signature)))) {
    return `a joining key's signature in the file cannot be read. ${ask}`;
  }
  if (x.signatures !== undefined && (!Array.isArray(x.signatures) || signatureListRefusal(x.signatures) !== null)) {
    return `a super admin's signature in the file cannot be read. ${ask}`;
  }
  return null;
}

/**
 * **WHY A LIST OF SIGNATURES IS NOT ONE THIS DEVICE READS OR SENDS**, or null:
 * a list with a gap or an empty place in it, or an entry that is not a
 * signature at a whole place on a committee. This guards this device's own
 * reading of a file or of what the service hands over. It is not what keeps a
 * gapped list off the chain: the ledger's own update class packs every list
 * this device sends, and the ledger's decoding already refuses a list whose
 * places are not all below its length.
 */
export function signatureListRefusal(list: readonly unknown[]): string | null {
  if (!Array.isArray(list)) return 'the signatures are not a list';
  for (let i = 0; i < list.length; i += 1) {
    if (!(i in list)) return 'the list of signatures has a gap in it';
    const s = list[i] as Partial<SuperAdminSignature> | null;
    if (typeof s !== 'object' || s === null || typeof s.address !== 'string' || !HEX64.test(s.address.toLowerCase())
      || typeof s.counter !== 'string' || !DIGITS.test(s.counter) || !Number.isSafeInteger(s.index) || s.index! < 0
      || typeof s.signature !== 'object' || s.signature === null || typeof s.signature.tag !== 'string'
      || typeof s.signature.value !== 'string' || !HEX.test(s.signature.value)) {
      return 'an entry in the list of signatures is not a signature on a contract\'s update';
    }
  }
  return null;
}

/** The update one contract is moved by: the committee installed, signed at the counter the chain holds it at. */
const updateBytes = (doors: Pick<SuperAdminDoors, 'ledger'>, address: string, counter: bigint, change: SuperAdminChangeOnTheWire): Uint8Array =>
  committeeReplacement(doors.ledger, {
    vault: address, counter, to: { committee: change.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: change.threshold },
  }).dataToSign;

/**
 * **THE SIGNATURES THAT COUNT FOR ONE CONTRACT NOW**: each at the counter the
 * chain holds the contract at, at a place on the committee holding it on the
 * chain, verifying under that place's key over that contract's update - one
 * per place, in increasing order. Anything else, from any device or the
 * service, counts for nothing.
 */
function countedFor(
  doors: Pick<SuperAdminDoors, 'ledger'>, change: SuperAdminChangeOnTheWire, address: string, now: ContractAuthority,
  signatures: readonly SuperAdminSignature[],
): ReadonlyArray<{ readonly index: number; readonly signature: Key }> {
  const data = updateBytes(doors, address, now.counter, change);
  const byIndex = new Map<number, Key>();
  for (const s of signatures) {
    if (s.address.toLowerCase() !== address || s.counter !== now.counter.toString() || byIndex.has(s.index)) continue;
    const key = now.committee[s.index];
    if (key === undefined) continue;
    let good = false;
    try { good = doors.ledger.verifySignature(key as never, data, { tag: s.signature.tag, value: s.signature.value } as never); } catch { good = false; }
    if (good) byIndex.set(s.index, { tag: s.signature.tag, value: s.signature.value });
  }
  return [...byIndex].sort(([a], [b]) => a - b).map(([index, signature]) => ({ index, signature }));
}

/** Where one contract of a change of the super admins stands, as this device read it off the chain. */
export interface SuperAdminContractStanding {
  readonly contract: 'account' | 'vault';
  readonly address: string;
  /**
   * `current`: it holds the change's committee at a counter past the one the
   * change named for it. `waiting`: not enough
   * signatures count yet. `ready`: enough count. `sent`: sent and shown on
   * the chain. `not-shown`: sent, and the chain does not show it yet.
   * `moved`: its counter moved and it does not hold the change's committee, so
   * every signature at the old counter is spent. `unreadable`: the chain could
   * not be asked who holds it.
   */
  readonly state: 'current' | 'waiting' | 'ready' | 'sent' | 'not-shown' | 'moved' | 'unreadable';
  readonly have: number;
  readonly required: number;
  readonly why: string | null;
}

/** Where a change of the super admins stands, read on this device: every device reads the same from the chain and the file. */
export interface SuperAdminChangeProgress {
  /** The super admins and the company's contracts as this device shows them, the change in progress included. */
  readonly seen: SuperAdminsSeen;
  /** Joining keys, read from each contract's committee on the chain, that have not signed the change themselves: no wallet signs, nothing counts ready and nothing is sent while any is listed. */
  readonly joinsMissing: readonly Key[];
  readonly contracts: readonly SuperAdminContractStanding[];
  /** Every contract of the company, read from the chain now, that the change does not name and that does not hold its committee. */
  readonly leftOut: readonly string[];
  /** True once every contract the change names holds its committee at a counter past the one named for it, and every other contract of the company, read from the chain now, holds that committee. */
  readonly done: boolean;
  /** Why nothing more was sent from here, in words for the person; null when nothing held it back. */
  readonly held: string | null;
}

export interface SuperAdminChangeRaised {
  /** The file to hand to the joining keys' holders and the other super admins. Nothing was sent. */
  readonly file: ProposalFile;
  readonly seen: SuperAdminsSeen;
  /** Keys the change puts on any contract it names, read from each one's committee on the chain: each must sign it with its own key before any wallet signs an update. */
  readonly joining: readonly Key[];
  /** Said, never refused: one key left, or every key needed (`committeeWarning`). */
  readonly warnings: readonly string[];
}

export interface SuperAdminChangeApproved extends SuperAdminChangeProgress {
  /** The file with this device's signatures added, to hand on. */
  readonly file: ProposalFile;
  /** Whether this person's wallet was asked: false when they hold no place, at the chain's counter, on any contract still to move. */
  readonly asked: boolean;
}

/** One contract a change names, as this device read it: `confirmed` when the account's lists or the company's own records here show it is the company's. */
interface NamedContract {
  readonly contract: 'account' | 'vault';
  readonly address: string;
  /** The counter the change names for it. */
  readonly counter: string;
  readonly authority: ContractAuthority | null;
  readonly why: string | null;
  readonly current: boolean;
  readonly confirmed: boolean;
}

/** The change in progress as `superAdminsHere` compares contracts with it. */
const inProgressOf = (change: SuperAdminChangeOnTheWire): SuperAdminChangeInProgress => ({
  committee: change.committee.map((k) => ({ tag: k.tag, value: k.value.toLowerCase() })),
  threshold: change.threshold,
  contracts: change.contracts.map((c) => ({ address: c.address, counter: BigInt(c.counter) })),
});

/** The company and account a file names, read as a wallet takes them, or refused. */
function companyOf(file: Pick<ProposalFile, 'company' | 'account'>): { company: CompanyLabel; account: AccountAddress } {
  const company = readCompanyLabel(file.company);
  const account = readAccountAddress(file.account?.toLowerCase());
  if (company === null || account === null) throw new Error('the company is not named by its label and its account\'s address. Nothing was built or sent');
  return { company, account };
}

/**
 * **A CHANGE OF THE SUPER ADMINS RAISED ON THIS DEVICE.** The committee asked
 * for must pass the one install rule; the person must be a super admin, their
 * own wallet's key on the account's committee as the chain holds it at their
 * wallet's indexer; every contract the company has made is read there, and
 * every one is named with its counter, the account first, those already
 * holding the committee asked for too. Nothing is sent: the file is handed to every joining key's
 * holder, who signs it with their own key, and to the super admins. No seat,
 * signer, signers' threshold or roster is read.
 */
async function raiseSuperAdminChange(doors: SuperAdminDoors, input: SuperAdminsAskedFor): Promise<SuperAdminChangeRaised> {
  const { company, account } = companyOf({ company: input.company, account: input.account });
  const to = { committee: input.change.committee.map((k) => ({ tag: k.tag, value: k.value.toLowerCase() })), threshold: input.change.threshold };
  const notInstallable = whyNotInstallable(to);
  if (notInstallable !== null) throw new Error(`${notInstallable} Nothing was raised`);
  const mine = await doors.wallet.key({ company, account });
  const seen = await superAdminsSeenHere(doors.readers, doors.chain, {
    account, createdByTheCompany: doors.createdByTheCompany, inProgress: null, seats: doors.seats, ownWalletKey: mine,
  });
  if (!seen.iAmOne) {
    throw new Error('the key your wallet gives for this company is not on the committee holding its account, as your wallet\'s indexer shows it, '
      + 'so you are not one of its super admins and cannot raise a change of them. Nothing was raised');
  }
  const unreadable = seen.contracts.find((c) => c.authority === null);
  if (unreadable !== undefined) {
    throw new Error(`the chain could not be asked who holds vault ${unreadable.address} (${unreadable.why ?? 'no answer'}), so a change `
      + 'cannot name every contract of the company. Nothing was raised. Try again when your wallet\'s indexer can read it');
  }
  const moving = seen.contracts.filter((c) => c.authority !== null && !sameCommittee(c.authority, to));
  if (moving.length === 0) throw new Error('every contract of this company already holds that committee. Nothing was raised');
  /*
   * Every contract of the company is named, the account first, those already
   * holding the committee asked for too: each gets its update, so landing the
   * change moves every counter and no update signed for an earlier change can
   * still land on any of them.
   */
  const named = seen.contracts;
  const change: SuperAdminChangeOnTheWire = {
    kind: 'super-admins',
    from: { committee: seen.superAdmins.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: seen.superAdmins.threshold },
    committee: to.committee, threshold: to.threshold,
    contracts: named.map((c) => ({ contract: c.contract, address: c.address, counter: c.authority!.counter.toString() })),
  };
  const random = doors.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const salt = hexOf(random(32));
  const file: ProposalFile = {
    format: PROPOSAL_FILE_FORMAT, company, account, change, salt, chainId: superAdminChangeId(company, account, salt, change),
    summary: input.summary, joined: [], signatures: [],
  };
  const why = proposalFileRefusal(file);
  if (why !== null) throw new Error(`${why}. Nothing was raised`);
  const warning = committeeWarning(to);
  return { file, seen, joining: joiningKeys(to.committee, named.map((c) => c.authority!)), warnings: warning === null ? [] : [warning] };
}

/**
 * **A FILE'S CHANGE OF THE SUPER ADMINS, CHECKED AGAINST THE CHAIN AT THE
 * PERSON'S OWN WALLET'S INDEXER**: the file's shape and identity; every
 * joining signature it carries verifying over the change's bytes under the key
 * it names, which must be one the change installs; and the committee holding
 * the account on the chain being the one the change says it replaces at the
 * counter it was raised at, or the one it installs one counter on.
 * The joining keys are each contract's to-be committee less the committee the
 * chain holds it at now. Each contract it names is read there; one that is
 * not the company's as the account's lists and the company's own records on
 * this device find it is still read and counted, so nothing is sent while it
 * lacks its signatures, but this device never asks its wallet to sign it and
 * never sends it: a device holding the company's records does.
 */
async function superAdminChangeAgainstTheChain(doors: SuperAdminDoors, file: ProposalFile, mine: Key | null) {
  const why = proposalFileRefusal(file);
  if (why !== null) throw new Error(`${why}. Nothing was built or sent`);
  const change = file.change as SuperAdminChangeOnTheWire;
  const { company, account } = companyOf(file);
  if (superAdminChangeId(company, account, file.salt, change) !== file.chainId.toLowerCase()) {
    throw new Error('the change in this file is not the one its identity names. Nothing was built or sent. Do not approve it; ask the super admin who raised it');
  }
  const bytes = superAdminChangeBytes(company, account, file.salt, change);
  for (const j of file.joined ?? []) {
    if (!keyAt(change.committee, j.key)) throw new Error('the file carries a signature from a key the change does not add. Nothing was built or sent. Do not approve it');
    if (!joinedBy(doors.ledger, bytes, j.key, j.signature)) {
      throw new Error('a joining key\'s signature in the file is not its signature over this change. Nothing was built or sent. Do not approve it; ask its holder to sign the change again');
    }
  }
  const seen = await superAdminsSeenHere(doors.readers, doors.chain, {
    account, createdByTheCompany: doors.createdByTheCompany, inProgress: inProgressOf(change), seats: doors.seats, ownWalletKey: mine,
  });
  /*
   * The change is the account's next one only while the account sits at the
   * counter it was raised at, held by the committee it replaces, or has just
   * taken it, one counter on: a change that ran or was turned down is never
   * taken again, whatever committee the account has come back to since.
   */
  const raisedAt = BigInt(change.contracts[0]!.counter);
  const atFrom = sameCommittee(seen.superAdmins, change.from) && seen.superAdmins.counter === raisedAt;
  const atTo = sameCommittee(seen.superAdmins, { committee: change.committee, threshold: change.threshold }) && seen.superAdmins.counter === raisedAt + 1n;
  if (!atFrom && !atTo) {
    throw new Error('the company\'s account, as your wallet\'s indexer shows it, is not held by the committee this change says it replaces, at the counter '
      + 'it was raised at, nor by the committee it installs one counter on. Nothing was built or sent. Do not approve it; ask the super admin who raised it');
  }
  /*
   * Every change names every contract of the company. One this device finds on
   * the chain - the account's lists, or the company's own records here - that
   * the change leaves out, and that does not hold the change's committee, could
   * still take an update signed for an earlier change, so nothing is signed,
   * joined or sent for this one.
   */
  const inTheChange = new Set(change.contracts.map((c) => c.address.toLowerCase()));
  const leftOut = seen.contracts.filter((c) => !c.current && !inTheChange.has(c.address.toLowerCase())).map((c) => c.address);
  if (leftOut.length > 0) {
    throw new Error(`this change leaves out vault ${leftOut.join(' and vault ')}, which the company has on the chain and which is not held by `
      + 'the committee the change installs. Every change names every contract of the company. Nothing was signed or sent. Do not approve it; '
      + 'ask the super admin who raised it to raise a change that names every contract');
  }
  const found = new Map(seen.contracts.map((c) => [c.address, c]));
  const to = { committee: change.committee, threshold: change.threshold };
  /* A contract the change moved: it holds the change's committee at a counter past the one the change named for it. */
  const movedTo = (a: ContractAuthority | null, raised: string): boolean => a !== null && sameCommittee(a, to) && a.counter > BigInt(raised);
  const named: NamedContract[] = [];
  for (const c of change.contracts) {
    const f = found.get(c.address);
    if (f !== undefined) {
      named.push({ contract: f.contract, address: f.address, counter: c.counter, authority: f.authority, why: f.why, current: movedTo(f.authority, c.counter), confirmed: true });
      continue;
    }
    const authority = await authorityHere(doors.readers, doors.chain, c.address);
    named.push({
      contract: c.contract, address: c.address, counter: c.counter, authority, confirmed: false,
      why: authority === null ? 'the indexer your wallet names holds no contract there that can be read' : null,
      current: movedTo(authority, c.counter),
    });
  }
  const holders = named.flatMap((c) => (c.authority === null || c.current ? [] : [c.authority]));
  const joining = joiningKeys(change.committee, holders);
  const joinsMissing = joining.filter((k) => !(file.joined ?? []).some((j) => sameKey(j.key, k)));
  return { company, account, change, bytes, seen, named, joining, joinsMissing };
}

/**
 * **A JOINING KEY'S HOLDER SIGNS THE CHANGE WITH THAT KEY**, on their own
 * device: the file checked against the chain, their wallet's key for the
 * company being one the change adds, and their wallet asked to sign the
 * change's bytes exactly, after it shows who joins and leaves and the
 * threshold. The signature is checked here before it is added. Returns the
 * file to hand on; nothing is sent.
 */
export async function joinFromAFile(doors: SuperAdminDoors, file: ProposalFile): Promise<ProposalFile> {
  if (!isSuperAdminFile(file)) throw new Error('only a change of the super admins is joined with a key\'s own signature. Nothing was signed');
  const { company, account } = companyOf(file);
  const mine = await doors.wallet.key({ company, account });
  const { change, bytes, joining } = await superAdminChangeAgainstTheChain(doors, file, mine);
  if (!keyAt(joining, mine)) {
    throw new Error('the key your wallet gives for this company is not one this change adds, so there is nothing for you to sign as a joining key. Nothing was signed');
  }
  const signed = await doors.wallet.signJoin({ company, account, salt: file.salt, change, bytes });
  if (!sameKey(signed.signer, mine) || !joinedBy(doors.ledger, bytes, mine, signed.signature.toLowerCase())) {
    throw new Error('the wallet did not sign this change with the key it gives for this company, so nothing was added. Nothing was sent');
  }
  return {
    ...file,
    joined: [...(file.joined ?? []).filter((j) => !sameKey(j.key, mine)), { key: { tag: mine.tag, value: mine.value.toLowerCase() }, signature: signed.signature.toLowerCase() }],
  };
}

/**
 * **A SUPER ADMIN'S ONE PRESS**: the file checked against the chain; refused,
 * with no wallet asked, while any key the change puts on a contract has not
 * signed the change itself; then their wallet asked once to sign the update
 * of every contract still to move on whose committee, as the chain holds it
 * now, their key sits at a place not yet signed, at that contract's counter
 * now, the ask carrying the change's bytes and its joining signatures. A key's standing to sign a
 * contract's update is being on that contract's committee on the chain and
 * nothing else. Then the change is taken as far as it can go
 * (`resumeFromAFile`), so the device whose signature completes it sends it.
 */
async function approveSuperAdminChange(doors: SuperAdminDoors, file: ProposalFile): Promise<SuperAdminChangeApproved> {
  const { company, account } = companyOf(file);
  const mine = await doors.wallet.key({ company, account });
  const { change, bytes, named, joinsMissing } = await superAdminChangeAgainstTheChain(doors, file, mine);
  if (joinsMissing.length > 0) {
    throw new Error(`${joinsHeld(joinsMissing.length)}, so your wallet is not asked to sign any contract's update: a key nobody holds is never put on `
      + 'the company\'s contracts. Hand the file to each joining key\'s holder first. Nothing was signed or sent');
  }
  const held = file.signatures ?? [];
  const toSign = named.flatMap((c) => {
    if (c.authority === null || c.current || !c.confirmed) return [];
    const counted = new Set(countedFor(doors, change, c.address, c.authority, held).map((s) => s.index));
    const places = c.authority.committee.flatMap((k, i) => (sameKey(k, mine) && !counted.has(i) ? [i] : []));
    return places.length === 0 ? [] : [{ contract: c.contract, address: c.address, counter: c.authority.counter.toString() }];
  });
  let next = file;
  if (toSign.length > 0) {
    const signed = await doors.wallet.signUpdates({
      company, account, salt: file.salt, change, bytes, joined: file.joined ?? [], contracts: toSign,
    });
    if (!sameKey(signed.signer, mine)) throw new Error('the wallet signed with a key other than the one it gives for this company, so nothing was kept. Nothing was sent');
    const added = signed.signatures.map((s) => ({
      address: s.address.toLowerCase(), counter: s.counter, index: s.seat, signature: { tag: s.signature.tag, value: s.signature.value },
    }));
    const listed = signatureListRefusal(added);
    if (listed !== null) throw new Error(`the wallet's answer could not be read: ${listed}. Nothing was kept or sent`);
    const fresh = (s: SuperAdminSignature) => !added.some((a) => a.address === s.address && a.counter === s.counter && a.index === s.index);
    next = { ...file, signatures: [...held.filter(fresh), ...added] };
  }
  return { file: next, asked: toSign.length > 0, ...(await resumeFromAFile(doors, next)) };
}

/**
 * **A CHANGE OF THE SUPER ADMINS TAKEN AS FAR AS IT CAN GO FROM THIS DEVICE**,
 * from the file it holds and the signatures the service hands over, each
 * counted only where it verifies (`countedFor`). Nothing is sent while a
 * joining key has not signed the change itself, or any contract still to move
 * lacks its committee's threshold of signatures at its counter now. Then the
 * account's update is sent first through the company's service, the one way a
 * maintenance update is sent today, and believed only once the account reads
 * current at the wallet's indexer; only then is each vault's sent, one at a
 * time, each judged the same way. A send the chain does not show stops the
 * rest; reading the file again later finishes it from any super admin's
 * device, and a contract that already moved is never sent again.
 */
export async function resumeFromAFile(doors: SuperAdminDoors, file: ProposalFile): Promise<SuperAdminChangeProgress> {
  if (!isSuperAdminFile(file)) throw new Error('only a change of the super admins is finished from this device this way. Nothing was sent');
  const { company, account } = companyOf(file);
  const mine = await doors.wallet.key({ company, account }).catch(() => null);
  const { account: accountRead, change, seen, named, joinsMissing } = await superAdminChangeAgainstTheChain(doors, file, mine);
  let fromService: readonly SuperAdminSignature[] = [];
  if (doors.service?.collected !== undefined) {
    try {
      const got = await doors.service.collected();
      if (Array.isArray(got) && signatureListRefusal(got) === null) fromService = got;
    } catch { /* the service's signatures are a convenience: without them, the file's are counted alone */ }
  }
  const all = [...(file.signatures ?? []), ...fromService];
  const standing = new Map<string, SuperAdminContractStanding>();
  const counted = new Map<string, ReadonlyArray<{ readonly index: number; readonly signature: Key }>>();
  for (const c of named) {
    if (c.authority === null) {
      standing.set(c.address, { contract: c.contract, address: c.address, state: 'unreadable', have: 0, required: 0, why: c.why });
      continue;
    }
    if (c.current) {
      standing.set(c.address, { contract: c.contract, address: c.address, state: 'current', have: 0, required: 0, why: null });
      continue;
    }
    const list = countedFor(doors, change, c.address, c.authority, all);
    counted.set(c.address, list);
    const moved = c.authority.counter.toString() !== c.counter;
    const enough = list.length >= c.authority.threshold;
    standing.set(c.address, {
      contract: c.contract, address: c.address, have: list.length, required: c.authority.threshold,
      /* Signatures on an update never make it ready while a joining key has not signed the change. */
      state: enough && joinsMissing.length === 0 ? 'ready' : moved && !enough ? 'moved' : 'waiting',
      why: enough && joinsMissing.length > 0
        ? 'it has its super admins\' signatures, and waits for every joining key to sign the change with its own key'
        : !c.confirmed
        ? 'it is not one this device can confirm as the company\'s, so it is signed and sent from a device holding the company\'s records'
        : moved && list.length < c.authority.threshold
          ? 'it was changed since the change was raised, so its update must be signed again at its counter now'
          : null,
    });
  }
  const order = named.map((c) => c.address);
  let sentAny = false;
  const result = async (heldBack: string | null): Promise<SuperAdminChangeProgress> => {
    const contracts = order.map((a) => standing.get(a)!);
    /* Read again after anything was sent, so what is shown is the chain as it stands now. */
    const shownNow = sentAny ? await superAdminsSeenHere(doors.readers, doors.chain, {
      account: accountRead, createdByTheCompany: doors.createdByTheCompany, inProgress: inProgressOf(change), seats: doors.seats, ownWalletKey: mine,
    }) : seen;
    /* Every contract of the company as the chain shows it now, so a vault the change left out keeps it from being done. */
    const leftOut = shownNow.contracts.filter((c) => !c.current && !order.includes(c.address)).map((c) => c.address);
    const done = contracts.every((c) => c.state === 'current' || c.state === 'sent') && shownNow.behind.length === 0;
    const notNamed = leftOut.map((a) => `vault ${a} is not in this change and is not held by its committee on the chain, so the company is not done. `
      + 'Raise a change that names it').join('; ');
    return { seen: shownNow, joinsMissing, contracts, leftOut, done, held: heldBack ?? (notNamed === '' ? null : notNamed) };
  };
  const pending = order.filter((a) => !['current', 'sent'].includes(standing.get(a)!.state));
  if (pending.length === 0) return result(null);
  if (joinsMissing.length > 0) {
    return result(`${joinsHeld(joinsMissing.length)}, so nothing is sent: a key nobody holds is never put on the company's contracts`);
  }
  if (pending.some((a) => standing.get(a)!.state !== 'ready')) {
    return result('not every contract still to move has enough of its super admins\' signatures, so nothing is sent yet');
  }
  if (doors.service === undefined) return result('the company\'s service is not reachable from this page, and it is the one way a change is sent today');
  let leftForTheRecords: string | null = null;
  for (const address of pending) {
    /* The account is first in the change, and a send the chain does not show stops every one after it. */
    const s = standing.get(address)!;
    const c = named.find((x) => x.address === address)!;
    if (!c.confirmed) {
      leftForTheRecords = `vault ${address} is not one this device can confirm as the company's, so a device holding the company's records sends it`;
      continue;
    }
    const before = c.authority!;
    const list = counted.get(address)!;
    if (signatureListRefusal(list.map((x) => ({ address, counter: before.counter.toString(), ...x }))) !== null) {
      return result('the signatures for a contract could not be put in order, so nothing more was sent');
    }
    try {
      await doors.service.send({
        address, counter: before.counter.toString(), to: { committee: change.committee, threshold: change.threshold }, signatures: list,
        change: { company, salt: file.salt, change, joined: file.joined ?? [] },
      });
    } catch { /* what the service says is not believed either way: the chain is read below */ }
    const after = await watchedOnTheChain(doors, async () => {
      const now = await authorityHere(doors.readers, doors.chain, address);
      return now !== null && now.counter !== before.counter ? now : null;
    });
    sentAny = true;
    if (after === null) {
      standing.set(address, { ...s, state: 'not-shown', why: 'it was handed to the company\'s service, and the chain, as your wallet\'s indexer shows it, does not show it yet' });
      return result('a change handed to the company\'s service does not show on the chain yet, so nothing after it was sent. Open the file again in a few minutes to finish it');
    }
    if (!sameCommittee(after, { committee: change.committee, threshold: change.threshold })) {
      standing.set(address, { ...s, state: 'moved', why: 'another change landed on it first, so this change\'s signatures for it are spent' });
      return result('a contract was changed by another change first, so nothing after it was sent');
    }
    sentAny = true;
    standing.set(address, { ...s, state: 'sent' });
  }
  return result(leftForTheRecords);
}

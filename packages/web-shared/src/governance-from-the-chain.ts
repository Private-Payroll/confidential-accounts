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
 */
import { commit } from '../../../src/core/crypto.js';
import { assetIdHex, NO_ASSET } from '../../../src/core/assets.js';
import type { ResumesFrom } from '../../../src/midnight/record-tree.js';
import type {
  AccountCallChainOnTheWire, VaultBuilderClient,
} from './vault-worker-client.js';
import type { GovernanceOnTheWire, OpenedRound, RoundOnChain, SignerMaterial } from './governed-call-builder.js';
import { sameGovernance } from './governance-compared.js';

/** What names a proposal file, so a file of any other kind is never read as one. */
export const PROPOSAL_FILE_FORMAT = 'confidential-accounts/proposal-file/v1';

/**
 * **A GOVERNANCE PROPOSAL, AS ITS RAISER HANDS IT TO THE OTHER SIGNERS**: the
 * company and its account, the change and the salt the proposal was raised
 * with, its identity on chain, the words the person is shown, and what the
 * change's own check reads beside it - for a recovery of the record anchor,
 * the header it resumes from. Nothing in it is believed: the identity is made
 * again from the change and the salt, and the chain must hold it open.
 */
export interface ProposalFile {
  readonly format: typeof PROPOSAL_FILE_FORMAT;
  readonly company: string;
  readonly account: string;
  readonly change: GovernanceOnTheWire;
  readonly salt: string;
  readonly chainId: string;
  readonly summary: string;
  /** A recovery's: the header it resumes from, whose head its change names; the change also names the last time it may be carried out. */
  readonly resumesFrom?: ResumesFrom;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const KINDS = new Set(['add-signer', 'threshold', 'vault-threshold', 'spending-policy', 'policy-bar', 'recover-anchor']);

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
): Promise<{ readonly sentBy: SentBy; readonly approvalsBefore: number }> {
  const { opened, standing } = await fileAgainstTheChain(doors, file);
  await check(file);
  const chain = await callStateHere(doors);
  const { tx } = await doors.builder.governedCall({
    account: chain.account, material: doors.material, chain, opened,
    order: { circuit: 'approve', proposal: opened.chainId, of: { governance: file.change, proposalSalt: file.salt } },
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

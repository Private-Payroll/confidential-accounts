/**
 * **WHAT THIS DEVICE AND THE COMPANY'S SERVICE SAY TO EACH OTHER ABOUT A
 * PROPOSAL, AND WHERE A SENT ONE STANDS.**
 *
 * The service writes a proposal down and hands over what the device needs to
 * build it; the worker proves the call with this signer's own key material, and
 * the service pays the network fee and sends it, so nothing that proves
 * membership leaves this device. A send ends one of three ways: refused before
 * anything was sent, which the service marks; sent and counted by the chain; or
 * sent and not yet seen, which is said as exactly that so the person does not
 * send it again. Where a proposal stands is read from the chain through the
 * company's records, and an answer about another proposal than the one asked
 * is refused.
 */
import type { KeysHeld } from '../../../src/core/company-key.js';
import { DEVICE_RAISE_VERSION } from '../../../src/core/device-raise.js';
import type { SignerMaterial, OpenedRound } from './governed-call-builder.js';
import { signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import type { RetirementSignature, SealedAccount, SealedProposal } from '../../../src/core/types.js';
import type { AccountCallChainOnTheWire, VaultBuilderClient } from './vault-worker-client.js';
import { standingOnChainHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import { NotOpenedOnThisDevice, openTheRoundHere } from './round-opened-here.js';
import { NotHandedOver, serviceNotReached, type HandOver } from './hand-over.js';
import type { SignedRunFiling } from '../../../src/core/run-filing.js';
import type { SignedProposalFiling } from '../../../src/core/proposal-filing.js';
import type { SeatingReads } from './roster-here.js';
import type { LeavingReads } from './seats-leaving-here.js';

/* Where a proposal is opened on this device, said once in its own file, and named here for whoever raises or approves. */
export { NotOpenedOnThisDevice, openTheRoundHere };

/** The parts of a proposal this module reads: what the service keeps of it outside its envelope. */
export interface RoundOnThePage {
  readonly id: string;
  readonly chainId: string;
  readonly status: string;
  readonly txRef?: string;
  readonly raisedAt?: string;
  /** How many approvals the chain counts for it, as the service last read. Never whose. */
  readonly approvalCount?: number;
  /** Read from the chain for this device's seat: the chain holds this seat's approval of it (`RoundOnChain.approvedHere`). */
  readonly approvedHere?: boolean;
  /**
   * Read from the chain: open, and a signer was removed or replaced since it was raised, so the account will never carry
   * out a change to the company it asks (`RoundOnChain.outrun`).
   */
  readonly outrun?: true;
  /** What the person is shown for it, when the page shows it. */
  readonly summary?: string;
  /**
   * Where a raise from this device left the company's records: `true` when what
   * it filed was entered and anchored from here, and otherwise why not. What it
   * filed is NOT YET ANCHORED until a device anchors it, which the next anchor
   * from any seat does for an entered filing.
   */
  readonly recordsAnchored?: true | string;
}

/** A proposal's raise, approval, withdrawal or carrying out, as the service relays it: a proven call and nothing else. */
export interface GovernedCallService {
  callState(accountId: string): Promise<AccountCallChainOnTheWire & { readonly account: string }>;
  /** A proposal's raise this device proved, sent. */
  send(proposalId: string, body: { tx: string; version: typeof DEVICE_RAISE_VERSION; filer: string }): Promise<RoundOnThePage>;
  /** An approval this device proved, sent, with this seat's signature over a removal's retirement where it signs one. */
  approve(proposalId: string, body: { tx: string; filer: string; retirement?: RetirementSignature }): Promise<RoundOnThePage>;
  /** This seat's signature over a removal's retirement, signed again for the directory version next now. Sends no call. */
  retire?(proposalId: string, body: { signature: RetirementSignature; filer: string }): Promise<RoundOnThePage>;
  /** Where a proposal stands on the chain now. Sends nothing. */
  standing(proposalId: string): Promise<RoundOnThePage>;
  /** A withdrawal: the call this device proved when the chain holds the proposal, none when it was only written down. */
  cancel?(proposalId: string, body: { tx?: string; filer: string }): Promise<RoundOnThePage>;
  /**
   * A proposal this device sealed and signed, written down, and its raise sent with it; with no `tx`, written down
   * only, for a proposal the chain already holds.
   */
  file?(accountId: string, body: {
    proposal: SignedProposalFiling; tx?: string; version?: typeof DEVICE_RAISE_VERSION;
    /**
     * The proposal's salt, so the service can hold a vault's or a governance proposal's identity on the chain to the
     * vault it names, or to none. A run's commitment to what it pays is keyed with the company's asset blinding too, so
     * the salt does not open it.
     */
    salt: string;
    /** A new vault's first secret run, whose one leaf pays a zero amount of no asset: the vault its identity on the chain is made for. */
    vault?: string;
    /** A payroll run's leg: the run re-filed as raised. What the raise pays is never sent: it is sealed in the two records. */
    run?: SignedRunFiling;
  }): Promise<RoundOnThePage>;
  /** An approved governance proposal carried out by the call this device proved. */
  carry?(proposalId: string, body: { tx: string; circuit: CarryCircuit; filer: string }): Promise<RoundOnThePage>;
  /**
   * An approved run charged to its vault's period by the call this device
   * proved. The run's proposal stays open on the chain, to be paid.
   */
  charge?(proposalId: string, body: { tx: string; filer: string }): Promise<RoundOnThePage>;
  /**
   * A proposal carried out or withdrawn by a call sent another way than through our service, closed in the service's record as the
   * service's own read of the account's history shows it closed; `how` is what this device believes, which the
   * service only compares. No call is sent.
   */
  closed?(proposalId: string, body: { filer: string; how?: 'carried' | 'withdrawn' }): Promise<RoundOnThePage>;
  /** The company's own records, sealed as they are stored, for this device to open itself. */
  sealedProposals?(accountId: string): Promise<SealedProposal[]>;
  sealedAccount?(accountId: string): Promise<SealedAccount>;
}

/** The calls that carry out an approved governance proposal. */
export type CarryCircuit = 'removeSignerAndSetThreshold' | 'setThreshold' | 'setVaultThreshold' | 'setPolicy' | 'setPolicyBar';

type GovernedStage = 'checking-the-vault' | 'writing-down' | 'reading-the-chain' | 'building' | 'sending' | 'waiting-for-the-chain';

export interface GovernedCallDoors {
  readonly service: GovernedCallService;
  readonly builder: Pick<VaultBuilderClient, 'governedCall'> & Partial<Pick<VaultBuilderClient, 'proposalIdentity'>>;
  /** This signer's own three, from the keyring this device opened. */
  readonly material: SignerMaterial;
  readonly accountId: string;
  readonly progress?: (stage: GovernedStage) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * The company's records a payroll run is read from on this device, so that
   * an approval of one is built only for the run made again here. Without
   * them a payroll proposal is not approved from this device.
   */
  readonly records?: CompanyRecordsHere;
  /** How long to wait for the chain to show what was sent, and how often to ask. */
  readonly waitMs?: number;
  readonly everyMs?: number;
  /**
   * The leaf each opening makes, worked out in this device's vault worker: what
   * a person waiting for a seat is held to before their leaf is approved here
   * (`refuseASeatNotForTheInvited`). Without it, no seat is approved here.
   */
  readonly leaves?: SeatingReads['leaves'];
  /**
   * Where each finished call goes: through our service (the default), through the company's own service at the
   * address it chose, or straight to the chain from the person's own wallet; the two ways but ours tell our service
   * only what it keeps on record.
   */
  readonly handOver?: HandOver;
}

export const HEX64 = /^[0-9a-f]{64}$/u;
export const hexOfBytes = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** One proposal, opened on this device from the company's own records (`openTheRoundHere`), and from nowhere else. */
export const opensFor = (doors: LeavingReads) => (proposalId: string, viewingKey: KeysHeld, forARaise: boolean, onlyKind?: string): Promise<OpenedRound> =>
  openTheRoundHere(doors.service, doors.accountId, proposalId, viewingKey, forARaise, doors.records, doors.leaves, false, onlyKind);

/** Sent, and the chain has not shown it yet. Not a failure, and not to be sent again. */
export class SentAndNotYetSeen extends Error {
  constructor(what: string, readonly round: RoundOnThePage) {
    super(
      `${what} was sent and the chain has not shown it yet. Do not send it again: open the run later ` +
        'and it will say where the proposal stands.',
    );
    this.name = 'SentAndNotYetSeen';
  }
}

/**
 * The service's own mark of whether a refused send reached the chain, kept rather than guessed. A call the service
 * gave no answer to is never read as nothing sent: a step that handed anything over before it says it may have been.
 */
export const nothingWasSentBy = (e: unknown): boolean => !serviceNotReached(e) && (
  (e as { nothingWasSent?: unknown } | null)?.nothingWasSent === true
  || /Nothing was sent/u.test(String((e as { message?: unknown } | null)?.message ?? '')));

/**
 * The approvals a proposal counts toward carrying it out: the chain's count while it is open, and none once closed. A
 * closed proposal's `approvalCount` is its count when it closed, kept for showing; withdrawn or carried out, it can no
 * longer be approved or carried out, so that count never decides either.
 */
export const counted = (r: RoundOnThePage): number => (r.status === 'open' && typeof r.approvalCount === 'number' ? r.approvalCount : 0);

/**
 * **WHERE A PROPOSAL STANDS, AS THE CHAIN SAYS** (`standingOnChainHere`): what the
 * service answers names the proposal, and every field of where it stands - open,
 * withdrawn or carried out, its approvals, when the chain first held it and the
 * call that raised it - is replaced by the chain's, read at the indexer the
 * person's own wallet names.
 */
export const onChainHere = async (doors: GovernedCallDoors, round: RoundOnThePage): Promise<RoundOnThePage> => {
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot say where this proposal stands on '
      + 'the chain. Reload the page to get the current version.');
  }
  return (await standingOnChainHere(doors.records, [round]))[0]!;
};

/** The proposal the service names by `proposalId`, standing where the chain says. */
export const standingHere = async (doors: GovernedCallDoors, proposalId: string, chainId?: string): Promise<RoundOnThePage> =>
  onChainHere(doors, theRoundAsked(await doors.service.standing(proposalId), proposalId, chainId));

/**
 * **THE SERVICE'S ANSWER IS ABOUT THE PROPOSAL THIS DEVICE ASKED ABOUT**: every answer names a proposal, and where it
 * stands is then read from the chain under the identity the answer gives. An answer under another proposal's name or
 * identity would have this device read, wait on or report someone else's count, so nothing is decided from it. The
 * words never say nothing was sent: the answer may come after a send.
 */
class AnswerNotForThisProposal extends Error {
  constructor() {
    super('The company\'s service answered about another proposal than the one this device asked about, so nothing is '
      + 'decided from its answer. Do not send it again: open the proposal later, and it will say where it stands on the chain.');
    this.name = 'AnswerNotForThisProposal';
  }
}

/** The answer when it names `proposalId` and, where this device knows it, the identity `chainId`; refused otherwise. */
export const theRoundAsked = (answer: RoundOnThePage, proposalId: string, chainId?: string): RoundOnThePage => {
  if (answer === null || typeof answer !== 'object' || String(answer.id) !== String(proposalId)
    || (chainId !== undefined && String(answer.chainId).toLowerCase() !== String(chainId).toLowerCase())) {
    throw new AnswerNotForThisProposal();
  }
  return answer;
};

/** Asks where a proposal stands, on the chain, until `seen` says so, or until the wait is over. */
export const waitFor = async (
  doors: GovernedCallDoors, what: string, proposalId: string,
  seen: (r: RoundOnThePage) => boolean, last: RoundOnThePage,
): Promise<RoundOnThePage> => {
  const sleep = doors.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = doors.waitMs ?? 5 * 60_000;
  const everyMs = doors.everyMs ?? 6_000;
  doors.progress?.('waiting-for-the-chain');
  let now = last;
  for (let waited = 0; waited < waitMs; waited += everyMs) {
    await sleep(everyMs);
    try {
      now = await standingHere(doors, proposalId, last.chainId);
    } catch {
      /* A read that failed says nothing about what was sent; ask again. */
      continue;
    }
    if (seen(now)) return now;
  }
  throw new SentAndNotYetSeen(what, now);
};

/** Refuses, before anything is paid or sent, a call straight to the chain whose service cannot close its record. */
export const closesOnRecord = (service: GovernedCallService): void => {
  if (service.closed === undefined) {
    throw new NotHandedOver('this page cannot close the company\'s record of a proposal closed straight on the chain. Reload '
      + 'the page to get the current version. Nothing was sent.');
  }
};

/** The service's record of a proposal closed straight on the chain, as the service's own read of the chain allows. */
export const closedOnRecord = async (
  service: GovernedCallService, proposalId: string, chainId: string, filer: string, how: 'carried' | 'withdrawn',
): Promise<RoundOnThePage> => theRoundAsked(await service.closed!(proposalId, { filer, how }), proposalId, chainId);

/**
 * After a call that closes a proposal went straight to the chain: asks the service to close its record until its
 * read of the chain no longer holds the proposal open, or until the wait is over. The answer stands where the
 * service's record stands; where the proposal stands is always read from the chain afterwards.
 */
export const closedOnTheChainHere = async (
  doors: GovernedCallDoors, proposalId: string, chainId: string, how: 'carried' | 'withdrawn',
): Promise<RoundOnThePage> => {
  const sleep = doors.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = doors.waitMs ?? 5 * 60_000;
  const everyMs = doors.everyMs ?? 6_000;
  const stillOpen = (r: RoundOnThePage) => r.status === 'open' || r.status === 'approved';
  let now = await closedOnRecord(doors.service, proposalId, chainId, filerHere(doors), how);
  for (let waited = 0; stillOpen(now) && waited < waitMs; waited += everyMs) {
    doors.progress?.('waiting-for-the-chain');
    await sleep(everyMs);
    try {
      now = await closedOnRecord(doors.service, proposalId, chainId, filerHere(doors), how);
    } catch {
      /* A read that failed decides nothing; ask again. */
    }
  }
  return now;
};

/**
 * The filing key of the seat this device files under, made from the signing secret it holds: sent with every relay so
 * the service pays for that seat, among every entry the person filed. It is a public key; no secret leaves the device.
 */
export const filerHere = (doors: Pick<GovernedCallDoors, 'material'>): string => signingPublicKeyOf(doors.material.signingSecret as Hex);


/**
 * A refusal from the service keeps the service's own mark of whether anything was sent. A service that gave no answer
 * at all is passed on as it is, so a hand-over can read the chain and go around it.
 */
const marked = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (e) {
    if (serviceNotReached(e)) throw e;
    const message = (e as Error)?.message ?? String(e);
    throw Object.assign(new Error(message), { nothingWasSent: nothingWasSentBy(e) });
  }
};

/** A call's refusal marked with whether anything was sent, as `marked` marks it. */
export { marked as markedNothingSent };

/**
 * A door's fields with the company's keys added under the name the shared code reads them by. The keys are the
 * company's, opened by a seat, never a wallet's own key; the wallet builds every door that carries them through this,
 * so no wallet source names the field.
 */
export const withCompanyKeys = <T extends object>(door: T, keys: KeysHeld): T & { readonly viewingKey: KeysHeld } => ({ ...door, viewingKey: keys });

/** A door's fields with the one company key a record is sealed under, added the same way, for the doors that take a single key and not the keys held. */
export const withCompanyKey = <T extends object>(door: T, key: Hex): T & { readonly viewingKey: Hex } => ({ ...door, viewingKey: key });

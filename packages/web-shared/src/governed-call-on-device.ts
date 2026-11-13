/**
 * **PROPOSALS RAISED, APPROVED AND CARRIED OUT FROM THIS DEVICE: PAYROLL RUNS
 * AND THEIR RETRIES, AND CHANGES TO THE COMPANY - WHO IS SEATED, THE
 * THRESHOLDS, AND A SIGNER'S REMOVAL WITH ITS RETIREMENT AND THE CHANGE OF THE
 * COMPANY'S KEY AFTER IT.**
 *
 * The page's side of it. The company's service writes a proposal down and hands
 * over what the device needs to build it; the worker builds and proves the call
 * with this signer's own key material; the service pays the network fee and
 * sends what the device proved. **Nothing that proves membership leaves this
 * device**: what the service receives is a proven transaction and, for an
 * approval, a signature.
 *
 * **A SEND ENDS ONE OF THREE WAYS.** Refused before anything was sent, which
 * the service marks and this module keeps. Sent and counted by the chain. Or
 * sent and not yet seen, which is said as exactly that, and the person is told
 * not to send it again. The service sends a proposal again only when the chain
 * says it does not hold it, and the chain refuses a second approval from one
 * signer. A refusal before anything was sent is, on the screen, said like any
 * other failure.
 */
import type { SignerByAddressDoors } from './invitation-on-device.js';
import { openedWithAnyKey, sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import { boundaryKeyOfEntry, proposalEntry, type ManifestEntryBody } from '../../../src/midnight/record-manifest.js';
import { FiledNotEntered, type RecordsEntered } from './record-entered-here.js';
import { assets as theAssets, symbolOf, type AssetId, type AssetRegistry, type LedgerForm } from '../../../src/core/assets.js';
import { refuseWhatTheVaultCannotPay, type PaymentAsked, type VaultHoldings } from '../../../src/core/vault-holdings.js';
import {
  DEVICE_RAISE_VERSION, WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED, paymentsCheckedDigest, type PaymentChecked,
} from '../../../src/core/device-raise.js';
import type {
  SignerMaterial, OpenedRound, RaiseRunOrder, GovernanceOnTheWire, GovernedCallOrder, ProposalIdentity, RoundOnChain,
} from './governed-call-builder.js';
import { sameGovernance } from './governance-compared.js';
import type { AccountGovernance } from 'midnight-identity/profile/records-key';
import { commit, sign, signingPublicKeyOf, verify, type Hex, type Sealed } from '../../../src/core/crypto.js';
import {
  noAdminLeftRefusal, policyChangeRefusal, refuseLeavingAVaultShort, refusalSaid, removalThresholdRefusal, seatThresholdRefusal, thresholdCarryBar, thresholdCounted,
  type ApproverRoster, type BandInForce, type SeatRights,
  type GovernanceChange as VaultCheckChange, type SeatThresholdChange,
} from '../../../src/core/vault-approvers.js';
import { invitedSeatRightsOf } from '../../../src/core/seat-rights.js';
import { assetIdBytes, NO_ASSET } from '../../../src/core/assets.js';
import type { RetirementSignature, Role, SealedAccount, SealedProposal } from '../../../src/core/types.js';
import { payrollRoundOf, sameList, untoldRetryRounds } from '../../../src/core/retry-cover.js';
import type { AccountCallChainOnTheWire, VaultBuilderClient } from './vault-worker-client.js';
import { proposalsListedHere, signedStateHere, standingOnChainHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import { believedFilerHere, NotOpenedOnThisDevice, openTheRoundHere, type RecordsForTheRound } from './round-opened-here.js';
import { blockingProposalSaid, passedOverAs } from './blocking-proposal-said.js';
import { seatRaisingTheBarHere } from './seat-raising-the-bar-here.js';
import { handedOver, NotHandedOver, notThroughOurService, serviceNotReached, type HandOver } from './hand-over.js';
import { raiseLegHere, raiseRetryHere, type LegRaiseDoors } from './run-raised-here.js';
import type { SignedRunFiling } from '../../../src/core/run-filing.js';
import {
  addSignerByAddressIn, addSignerInvitationRefusalIn, paysCommitmentOf, proposalFilingRefusal, raiseByOf, raiseMayStillLandAt, sealGovernanceProposal, signProposalFiling, type GovernancePayloadBody,
  type RetirementTerms, type SignedProposalFiling,
} from '../../../src/core/proposal-filing.js';
import { directoryChangeMessage, type DirectorySeat, type SignedChange } from '../../../src/midnight/seat-directory.js';
import { COMPANY_RECORD_KINDS, WIRE_RECORDS } from '../../../src/midnight/sealed-record-wire.js';
import type { RecordsAsked } from '../../../src/midnight/records-held.js';
import type { RecordsKeyStatement } from 'midnight-identity/profile/records-key';
import type { DirectoryChangesKeptStore } from './tree-kept-here.js';
import { rotateTheCompanyKeyHere, type KeyRotated, type RotationDoors } from './company-key-here.js';
import { removalBoundaryRefusal } from './spending-policy-here.js';
import { removalApproversHere } from './removal-approvers-here.js';
import {
  believedSeatingsUnder, rosterHere, sameInvitation, seatingOf, type RosterDoors, type SeatingReads,
} from './roster-here.js';
import { invitationByAddressRefusal, NOT_APPROVED_SAID } from './invitation-signed-by-a-seat.js';
import { approvedInvitationRefusal, seatByAddressChangeOf, type Inviter, type SignedSeatInvitation } from '../../../src/core/invitation.js';
import { addressReadsOf, addressSeatedOrInvitedRefusal, type InviteAddressOf } from './address-seated-or-invited.js';

import {
  directoryNotYetAnchored, FOUNDING_ASKED, foundedOnChainHere, kindAsked, listedHere, pastTheRaisedBoundary, refusedForItsKey,
  type DirectoryHere, type LeavingBoundaries,
} from './vault-page-doors.js';
import {
  carryOrderHere, legPaymentsHere, raiseOrderHere, retryOrderHere, retryPaymentsHere, NotMadeHere,
} from './material-made-here.js';

/* Where a proposal is opened on this device, said once in its own file, and named here for whoever raises or approves. */
export { NotOpenedOnThisDevice, openTheRoundHere };

/** A proposal written down and not yet sent, as the service hands it to the device that builds it. */
export interface RaiseOrderOnTheWire {
  readonly proposalId: string;
  readonly chainId: string;
  readonly order: RaiseRunOrder;
  /**
   * What the proposal written down commits to paying, from its own record: the
   * commitment its filing carries (`paysCommitmentOf`), keyed with the salt and
   * the company's asset blinding in `order.half`. The payments the vault is
   * checked for are held to it.
   */
  readonly pays: string;
}

/** A retry written down and not yet sent: its proposal, and the people it pays as positions in the leg. */
export interface RetryOrderOnTheWire extends RaiseOrderOnTheWire {
  readonly indices: ReadonlyArray<number>;
}

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

/**
 * What raising one leg will ask its vault to pay, as the service hands it over:
 * a kind, a token and an amount per payment, and nothing about who is paid.
 */
export interface LegPaymentsOnTheWire {
  readonly asset: string;
  /** The form the leg pays in: privately from notes, or publicly from the vault's balance. */
  readonly form?: LedgerForm;
  readonly payments: ReadonlyArray<PaymentChecked<string, string>>;
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
type CarryCircuit = 'removeSignerAndSetThreshold' | 'setThreshold' | 'setVaultThreshold' | 'setPolicy' | 'setPolicyBar';

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

/** What a raise or a retry is built from and checked against, each made on this device. */
interface MadeHereDoors {
  legPayments(runId: string, viewingKey: KeysHeld, which?: { asset?: string; form?: LedgerForm }): Promise<LegPaymentsOnTheWire>;
  retryPayments(runId: string, viewingKey: KeysHeld, indices: readonly number[], which?: { asset?: string; form?: LedgerForm }): Promise<LegPaymentsOnTheWire>;
  raiseOrder(runId: string, viewingKey: KeysHeld, which?: { asset?: string; form?: LedgerForm }): Promise<RaiseOrderOnTheWire>;
  retryOrder(runId: string, viewingKey: KeysHeld, proposalId: string, which?: { asset?: string; form?: LedgerForm }): Promise<RetryOrderOnTheWire>;
}

/** Everything a raise or a retry is made from, from the company's records this device opens. */
const madeFromTheRecords = (records: CompanyRecordsHere, accountId: string): MadeHereDoors => ({
  legPayments: (runId, viewingKey, which) => legPaymentsHere(records, accountId, runId, viewingKey, which),
  retryPayments: (runId, viewingKey, indices, which) => retryPaymentsHere(records, accountId, runId, viewingKey, indices, which),
  raiseOrder: (runId, viewingKey, which) => raiseOrderHere(records, accountId, runId, viewingKey, which),
  retryOrder: (runId, viewingKey, proposalId, which) => retryOrderHere(records, accountId, runId, viewingKey, proposalId, which),
});

/** What this device makes a raise or a retry from: the company's records, and nothing else. */
const madeFor = (doors: GovernedCallDoors): MadeHereDoors => {
  if (doors.records === undefined) {
    throw new NotMadeHere('This page cannot read the company\'s records, so it cannot make a raise or a retry here. Reload '
      + 'the page to get the current version.');
  }
  return madeFromTheRecords(doors.records, doors.accountId);
};

const HEX64 = /^[0-9a-f]{64}$/u;
const hexOfBytes = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** One proposal, opened on this device from the company's own records (`openTheRoundHere`), and from nowhere else. */
const opensFor = (doors: LeavingReads) => (proposalId: string, viewingKey: KeysHeld, forARaise: boolean): Promise<OpenedRound> =>
  openTheRoundHere(doors.service, doors.accountId, proposalId, viewingKey, forARaise, doors.records, doors.leaves);

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
const counted = (r: RoundOnThePage): number => (r.status === 'open' && typeof r.approvalCount === 'number' ? r.approvalCount : 0);

/**
 * **WHAT IS SENT AGAIN IS A RAISE, OF THE PROPOSAL IT NAMES.** Anything else is
 * refused before the worker is asked, which also builds the run again and holds
 * it to the proposal's identity.
 */
export function refuseAnOrderThatIsNotThisRaise(order: RaiseOrderOnTheWire): void {
  const o = order.order as { circuit?: unknown; proposal?: unknown };
  if (o.circuit !== 'propose' || String(o.proposal).toLowerCase() !== String(order.chainId).toLowerCase()) {
    throw new Error('what the company handed this device is not the proposal it wrote down. Nothing was built or sent.');
  }
}

/**
 * **WHERE A PROPOSAL STANDS, AS THE CHAIN SAYS** (`standingOnChainHere`): what the
 * service answers names the proposal, and every field of where it stands - open,
 * withdrawn or carried out, its approvals, when the chain first held it and the
 * call that raised it - is replaced by the chain's, read at the indexer the
 * person's own wallet names.
 */
const onChainHere = async (doors: GovernedCallDoors, round: RoundOnThePage): Promise<RoundOnThePage> => {
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot say where this proposal stands on '
      + 'the chain. Reload the page to get the current version.');
  }
  return (await standingOnChainHere(doors.records, [round]))[0]!;
};

/** The proposal the service names by `proposalId`, standing where the chain says. */
const standingHere = async (doors: GovernedCallDoors, proposalId: string, chainId?: string): Promise<RoundOnThePage> =>
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
const waitFor = async (
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
const closesOnRecord = (service: GovernedCallService): void => {
  if (service.closed === undefined) {
    throw new NotHandedOver('this page cannot close the company\'s record of a proposal closed straight on the chain. Reload '
      + 'the page to get the current version. Nothing was sent.');
  }
};

/** The service's record of a proposal closed straight on the chain, as the service's own read of the chain allows. */
const closedOnRecord = async (
  service: GovernedCallService, proposalId: string, chainId: string, filer: string, how: 'carried' | 'withdrawn',
): Promise<RoundOnThePage> => theRoundAsked(await service.closed!(proposalId, { filer, how }), proposalId, chainId);

/**
 * After a call that closes a proposal went straight to the chain: asks the service to close its record until its
 * read of the chain no longer holds the proposal open, or until the wait is over. The answer stands where the
 * service's record stands; where the proposal stands is always read from the chain afterwards.
 */
const closedOnTheChainHere = async (
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
 * Builds the proposal written down, sends it, and waits for the chain to hold
 * it. **What it is built from is made on this device from the company's
 * records**, never handed over by the service. **The vault is checked on this
 * device first, every time** - a first send and a send again alike - because a
 * proposal written down days ago is paid from the vault as it is now. What was
 * checked is held to the commitment the proposal written down carries, and the
 * send carries only the proven call: the service is told nothing of what it pays.
 */
export async function sendRaiseFromDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: KeysHeld; asset?: string; form?: LedgerForm;
  },
): Promise<RoundOnThePage> {
  const { service } = doors;
  const asked = legAsked(input);
  const order = await madeFor(doors).raiseOrder(input.runId, input.viewingKey, asked);
  refuseAnOrderThatIsNotThisRaise(order);
  doors.progress?.('checking-the-vault');
  await refuseALegTheVaultCannotPay(doors, {
    runId: input.runId, viewingKey: input.viewingKey, ...asked, vault: order.order.run.vault, order,
  });
  return buildAndSend(doors, order, input.viewingKey, (tx) => service.send(order.proposalId, { tx, version: DEVICE_RAISE_VERSION, filer: filerHere(doors) }));
}

/**
 * The filing key of the seat this device files under, made from the signing secret it holds: sent with every relay so
 * the service pays for that seat, among every entry the person filed. It is a public key; no secret leaves the device.
 */
const filerHere = (doors: Pick<GovernedCallDoors, 'material'>): string => signingPublicKeyOf(doors.material.signingSecret as Hex);

/**
 * Builds and proves what the service wrote down, hands it to `send` (or, on another way, to the person's wallet or the company's own service),
 * and waits for the chain to hold it.
 */
async function buildAndSend(
  doors: GovernedCallDoors, order: RaiseOrderOnTheWire, viewingKey: KeysHeld,
  send: (tx: string) => Promise<RoundOnThePage>,
): Promise<RoundOnThePage> {
  const opened = await opensFor(doors)(order.proposalId, viewingKey, true);
  doors.progress?.('reading-the-chain');
  const chain = await doors.service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account, order: order.order, material: doors.material, chain, opened,
  });
  doors.progress?.('sending');
  const answer = await handedOver(doors.handOver, {
    tx, call: { kind: 'account-call', contract: chain.account, circuit: order.order.circuit },
    viaService: () => send(tx),
    after: () => doors.service.standing(order.proposalId),
  });
  const sent = await onChainHere(doors, theRoundAsked(answer, order.proposalId, opened.chainId));
  if (sent.raisedAt) return sent;
  return waitFor(doors, 'this proposal', order.proposalId, (r) => Boolean(r.raisedAt), sent);
}

/** A raise also needs to know what the vault holds privately, which only this device can read. */
export interface RaiseDoors extends GovernedCallDoors {
  /** The vault's private money, read from the pool this device opens. */
  readonly holdings: VaultHoldings;
  /** The asset rows the payments are checked against. The product's own when not given. */
  readonly assets?: AssetRegistry;
}

const DIGITS = /^[0-9]+$/u;

/**
 * **WHICH LEG A CALL NAMES**: its token, and its form where the run pays that
 * token both privately and publicly, as two legs side by side. Either is left
 * out where the run leaves no doubt, and nothing else is sent.
 */
const legAsked = (input: { asset?: string; form?: LedgerForm }): { asset?: string; form?: LedgerForm } => ({
  ...(input.asset === undefined ? {} : { asset: input.asset }),
  ...(input.form === undefined ? {} : { form: input.form }),
});

/**
 * **WHETHER THE VAULT CAN PAY THIS LEG'S PAYMENTS, PRIVATE OR PUBLIC, ASKED
 * HERE BEFORE ANYTHING IS SENT.** The vault's notes are opened on this device
 * and nowhere else, and the service no longer asks about public money either,
 * so this is the one place the question is answered for both forms. The leg's
 * payments are made on this device from the company's records; nothing about
 * them goes to the service. A refusal writes nothing and spends nothing. What
 * comes back is the digest of the payments checked.
 */
async function refuseALegTheVaultCannotPay(
  doors: RaiseDoors,
  input: { runId: string; viewingKey: KeysHeld; asset?: string; form?: LedgerForm; vault: string; order?: RaiseOrderOnTheWire },
): Promise<string> {
  const leg = await madeFor(doors).legPayments(input.runId, input.viewingKey, legAsked(input));
  return refusePaymentsTheVaultCannotPay(doors, leg, input);
}

/**
 * **THE CHECK ITSELF, OVER THE PAYMENTS MADE HERE FROM THE COMPANY'S RECORDS** -
 * a leg's, or a retry's. The digest returned is over exactly those payments, in
 * their order.
 *
 * **AND, WHEN A PROPOSAL IS WRITTEN DOWN, AGAINST THAT PROPOSAL.** Its digest
 * must be the digest of these payments, and its count of payees is the count
 * the payments are checked against, so what is checked is what will be built
 * and sent. Before anything is written down there is no proposal yet, and the
 * service compares what it writes down with the digest this returns.
 */
async function refusePaymentsTheVaultCannotPay(
  doors: RaiseDoors, leg: LegPaymentsOnTheWire, input: { asset?: string; form?: LedgerForm; vault: string; order?: RaiseOrderOnTheWire },
): Promise<string> {
  if ((input.asset !== undefined && leg.asset !== input.asset)
    || (input.form !== undefined && leg.form !== undefined && leg.form !== input.form)) {
    const registry = doors.assets ?? theAssets;
    const named = (asset: string, form: LedgerForm | undefined) =>
      `${form === undefined ? '' : `${form === 'shielded' ? 'private' : 'public'} `}${symbolOf(asset, registry)}`;
    throw new Error(`The service returned the ${named(leg.asset, leg.form)} payments when the `
      + `${named(input.asset ?? leg.asset, input.form)} payments were asked for. Nothing was sent for approval and no fee was spent.`);
  }
  const payments = leg.payments.map((p, at): PaymentAsked => {
    const kind = p.kind;
    if ((kind !== 'shielded' && kind !== 'unshielded') || !DIGITS.test(String(p.amount))) {
      throw new Error(`payment ${at + 1} on this run came back from the company in a shape this device cannot `
        + 'check. Nothing was raised and no fee was spent.');
    }
    return { payee: { kind }, token: String(p.token), amount: BigInt(p.amount) };
  });
  const checked = paymentsCheckedDigest(leg.payments);
  let payees = BigInt(payments.length);
  if (input.order !== undefined) {
    /*
     * **WHAT IS CHECKED IS WHAT THE PROPOSAL WRITTEN DOWN COMMITS TO PAYING.**
     * The payments come from the run's record of the leg; the commitment from
     * the proposal's own record, signed by the seat that filed it. Two records,
     * so a run changed after its proposal was written down is refused here.
     */
    const half = input.order.order.half as { proposalSalt?: unknown; assetBlinding?: unknown } | undefined;
    const salt = String(half?.proposalSalt ?? '');
    const assetBlinding = String(half?.assetBlinding ?? '');
    if (!/^[0-9a-f]{64}$/u.test(salt) || !/^[0-9a-f]{64}$/iu.test(assetBlinding)
      || paysCommitmentOf({ vault: input.vault, asset: leg.asset, payments: leg.payments }, salt, assetBlinding) !== String(input.order.pays).toLowerCase()) {
      throw new Error(WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED);
    }
    if (!DIGITS.test(String(input.order.order.run.payees))) {
      throw new Error('the proposal written down for this run does not say how many people it pays, so this device cannot '
        + 'check it. Nothing was built or sent. Reload the page and send it again. If this comes back, withdraw the '
        + 'proposal and raise the run again.');
    }
    payees = BigInt(input.order.order.run.payees);
    /* A retry is raised over its leg's own tree and pays only the people it names. */
    const named = (input.order as { indices?: unknown }).indices;
    if (Array.isArray(named)) payees = BigInt(named.length);
  }
  await refuseWhatTheVaultCannotPay(doors.holdings, {
    vault: input.vault,
    asset: (doors.assets ?? theAssets).require(leg.asset as AssetId),
    total: payments.reduce((a, p) => a + p.amount, 0n),
    payees,
    payments,
  }, ['shielded', 'unshielded']);
  return checked;
}

/**
 * **ONE LEG OF A RUN, RAISED FROM THIS DEVICE** (`raiseLegHere`), and waited
 * on until the chain holds it. The proposal and the run as raised are filed with
 * the proven raise, so a device that stops part way leaves a proposal that can
 * be sent again with `sendRaiseFromDevice`, never a second proposal over the
 * same people.
 */
export async function raiseRunOnDevice(
  doors: LegRaiseDoors,
  input: { runId: string; viewingKey: KeysHeld; asset?: string; form?: LedgerForm; vault: string; opensAt: string; closesAt: string },
): Promise<RoundOnThePage> {
  const sent = await onChainHere(doors, await raiseLegHere(doors, input));
  if (sent.raisedAt) return sent;
  return waitFor(doors, 'this proposal', sent.id, (r) => Boolean(r.raisedAt), sent);
}

/**
 * **WHO A RETRY OF A STOPPED RUN PAYS: THE PEOPLE THE RUN HAS NOT PAID, AND
 * NOBODY ELSE.** Read from the run's own payment view, as positions in the leg.
 * A person the account records as paid is never named, and neither is one a
 * person decided not to pay. Nothing is offered when the view could not say who
 * was paid, or could not prove its people are this run's: a retry chosen from an
 * answer about another payroll would be a retry of the wrong people.
 *
 * **AND ONLY WHEN THE RETRY CAN BE RAISED: NOBODY WHILE THE RUN'S WINDOW HAS NOT
 * CLOSED, AND NOBODY A SENT RETRY CAN STILL PAY.** While the run's own round can
 * still pay them a retry would be a second round over the same people, and so
 * would a retry over people another retry on the chain still covers; the
 * company refuses both. So the people offered are the view's `stranded` - owed,
 * with nothing left that can pay them - and none of its `outstanding` beyond.
 */
export function unpaidToRetry(view: {
  readonly answered: boolean;
  readonly status?: {
    readonly verified: boolean;
    readonly outstanding: ReadonlyArray<{ readonly index: number; readonly state: string }>;
    readonly phase?: string;
    readonly stranded?: ReadonlyArray<{ readonly index: number; readonly state: string }>;
  };
},
/**
 * People a retry not yet seen on chain already covers: written down and not
 * sent, sent and not yet seen, or whose raise did not answer. The view counts
 * only retries the chain holds, so it still lists these people as stranded;
 * the company refuses a second retry over them while that one's window is
 * open. They are not offered here - their own retry is, to be sent.
 */
covered: ReadonlyArray<number> = []): number[] {
  if (!view.answered || !view.status?.verified) return [];
  if (view.status.phase !== 'closed') return [];
  const taken = new Set(covered);
  return (view.status.stranded ?? [])
    .filter((p) => (p.state === 'failed' || p.state === 'unsent') && !taken.has(p.index))
    .map((p) => p.index)
    .sort((a, b) => a - b);
}

/** A retry written onto a leg, as the page reads it off the run. */
interface RetryOnTheLeg {
  readonly originalIndices: ReadonlyArray<number>;
  readonly opensAt: bigint | string | number;
  readonly closesAt: bigint | string | number;
  readonly vault: string;
  /** Absent when the retry was written onto the leg and its raise never answered. */
  readonly proposalId?: string;
}

/** The parts of a round the page reads to decide what may be done with it. */
interface RoundStanding {
  readonly id: string;
  readonly status: string;
  readonly raisedAt?: string;
  readonly txRef?: string;
  /** What a round's sealed payload is opened from, to read which run, leg and people it is for. */
  readonly kind?: string;
  readonly chainId?: string;
  readonly sealedPayload?: Sealed;
}

/**
 * **THE ROUNDS WRITTEN DOWN FOR ONE RUN'S LEG, WITH THE PEOPLE EACH RETRY
 * PAYS**, read out of each round's sealed payload with the company's keys,
 * newest first, exactly as the company reads them. A round this page holds no payload
 * for, or cannot open, is left out: it covers nobody here, and the company,
 * which opens every round, refuses a retry over its people all the same.
 */
export function roundsOfTheLeg(
  rounds: ReadonlyArray<RoundStanding>, viewingKey: KeysHeld, runId: string, asset?: string,
): Array<{ readonly id: string; readonly status: string; readonly retry?: readonly number[] }> {
  return rounds.flatMap((r) => {
    if (r.kind === undefined || r.chainId === undefined || r.sealedPayload === undefined) return [];
    let opened: ReturnType<typeof payrollRoundOf>;
    try {
      const round = {
        id: r.id, kind: r.kind, status: r.status, chainId: r.chainId as Hex, sealedPayload: r.sealedPayload,
        ...(r.raisedAt ? { raisedAt: r.raisedAt } : {}),
      };
      opened = openedWithAnyKey(viewingKey, (key) => payrollRoundOf(round, key));
    } catch {
      return [];
    }
    if (opened === null || opened.runId !== runId || (asset !== undefined && opened.asset !== asset)) return [];
    return [opened];
  });
}

const seconds = (s: bigint | string | number): bigint => BigInt(String(s));

/**
 * **A RETRY NOT YET SEEN ON CHAIN, AND WHAT SENDS IT.** One of three:
 *
 *   `untold`       written onto the leg, and its raise never answered, with a
 *                  round written down for exactly those people that can still
 *                  reach the chain (`untoldRetryRounds`, as the company reads
 *                  it). It is sent by raising exactly the same people with its
 *                  window and vault, which the company sends as itself. One
 *                  whose round was withdrawn, stopped, or never written down
 *                  covers nobody, and its people are offered again.
 *   `unsent`       written down and never sent.
 *   `sent-unseen`  sent from a device and not yet seen on chain. Sent again as
 *                  itself; the chain takes it once.
 *
 * Each covers its people until its window closes, exactly as the company
 * counts it. A retry withdrawn, stopped by policy, seen on chain, or whose
 * window has closed is none of these. A retry whose round this page cannot
 * find is left out: nothing here can say what would send it.
 */
interface PendingRetry {
  readonly kind: 'untold' | 'unsent' | 'sent-unseen';
  readonly retry: RetryOnTheLeg;
  readonly round?: RoundStanding;
}

export function pendingRetries(
  retries: ReadonlyArray<RetryOnTheLeg>, rounds: ReadonlyArray<RoundStanding>, nowInSeconds: number,
  /** The rounds written down for this run's leg, with the people each retry pays: `roundsOfTheLeg`. */
  legRounds: ReadonlyArray<{ readonly id: string; readonly status: string; readonly retry?: readonly number[] }>,
): PendingRetry[] {
  const now = BigInt(Math.floor(nowInSeconds));
  const untold = untoldRetryRounds(retries, legRounds, now);
  const pending: PendingRetry[] = [];
  for (const retry of retries) {
    if (now >= seconds(retry.closesAt)) continue;
    if (retry.proposalId === undefined) {
      if (untold.some((u) => sameList(u.people, retry.originalIndices))) pending.push({ kind: 'untold', retry });
      continue;
    }
    const round = rounds.find((r) => r.id === retry.proposalId);
    /* Withdrawn, stopped by policy, or seen on chain: nothing here to send. */
    if (!round || round.raisedAt || round.status !== 'open') continue;
    pending.push({ kind: round.txRef ? 'sent-unseen' : 'unsent', retry, round });
  }
  return pending;
}

/**
 * **WHETHER THE COMPANY WILL WITHDRAW THIS PROPOSAL.** A round only written down
 * is withdrawn here. One the chain holds is withdrawn only before its window
 * opens, which the chain enforces. One a device sent and the chain does not
 * show yet is not withdrawn: it may still arrive, so it is sent again instead.
 * A round settled or already withdrawn has nothing to withdraw.
 */
export function mayWithdraw(
  round: RoundStanding, opensAt: bigint | string | number | undefined, nowInSeconds: number,
): boolean {
  if (round.status !== 'open' && round.status !== 'approved' && round.status !== 'blocked') return false;
  if (round.status === 'blocked') return true;
  if (!round.raisedAt) return !round.txRef;
  return opensAt !== undefined && BigInt(Math.floor(nowInSeconds)) < seconds(opensAt);
}

/**
 * **A RETRY WRITTEN DOWN AND NOT YET SENT, BUILT AND SENT FROM THIS DEVICE.**
 * The vault is checked here for exactly the retry's payments right before the
 * send, every time, as a leg's are.
 */
export async function sendRetryFromDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: KeysHeld; asset?: string; form?: LedgerForm; proposalId: string;
  },
): Promise<RoundOnThePage> {
  const { service } = doors;
  const asked = legAsked(input);
  const order = await madeFor(doors).retryOrder(input.runId, input.viewingKey, input.proposalId, asked);
  if (order.proposalId !== input.proposalId) {
    throw new Error('the retry this device was handed is not the one on record. Reload the page and try again. Nothing '
      + 'was built or sent.');
  }
  refuseAnOrderThatIsNotThisRaise(order);
  doors.progress?.('checking-the-vault');
  await refusePaymentsTheVaultCannotPay(doors,
    await madeFor(doors).retryPayments(input.runId, input.viewingKey, order.indices, asked), { ...asked, vault: order.order.run.vault, order });
  return buildAndSend(doors, order, input.viewingKey, (tx) => service.send(order.proposalId, { tx, version: DEVICE_RAISE_VERSION, filer: filerHere(doors) }));
}

/**
 * **A RETRY OF SOME OF ONE LEG'S PEOPLE, RAISED FROM THIS DEVICE** over a tree
 * of its own (`raiseRetryHere`), and waited on until the chain holds it. A
 * device that stops part way leaves a retry written down that
 * `sendRetryFromDevice` sends as itself.
 */
export async function raiseRetryOnDevice(
  doors: LegRaiseDoors,
  input: {
    runId: string; viewingKey: KeysHeld; asset?: string; form?: LedgerForm; indices: ReadonlyArray<number>;
    vault: string; opensAt: string; closesAt: string;
  },
): Promise<RoundOnThePage> {
  const sent = await onChainHere(doors, await raiseRetryHere(doors, input));
  if (sent.raisedAt) return sent;
  return waitFor(doors, 'this retry', sent.id, (r) => Boolean(r.raisedAt), sent);
}

/** What the contract says when a proposal is carried out with fewer approvals than the account asks for it now. */
const NOT_ENOUGH_APPROVALS = 'not enough approvals yet';

/**
 * Whether a refusal is the chain's: the proposal has fewer approvals than the account asks for it now. A vault's
 * spending policy, or a signer removed since the proposal was raised, can ask more than the proposal named.
 */
export const notEnoughApprovalsYet = (e: unknown): boolean => String((e as Error | null)?.message ?? '').includes(NOT_ENOUGH_APPROVALS);

/**
 * **ONE APPROVAL, FROM THIS DEVICE.** The approval is built and proved in the
 * worker with this signer's own key material, sent, and the chain asked until
 * it holds this seat's approval.
 *
 * **WHAT IS PROVED IS THE PROPOSAL THIS DEVICE OPENED, AND IT IS THE ONE THE
 * PERSON WAS SHOWN.** The proposal is opened here from the company's sealed
 * records; its identity must be the one the page showed, and so must what it
 * says, or nothing is built. A payroll run is made again from the company's
 * records where the approval is built.
 *
 * **A CHANGE TO THE COMPANY IS NOT APPROVED HERE.** A seat, the company's
 * threshold or a vault's own approvals needed is approved where the change is
 * made (`changeThresholdOnDevice`, `changeVaultThresholdOnDevice`,
 * `seatSignerOnDevice`), which checks first that it leaves no vault unable to
 * pay and, for a seat, who is seated. Opened here, it is refused before
 * anything is built.
 *
 * **A RUN ITS SEAT RAISED AFTER ITS OWN REMOVAL WAS RAISED IS NOT APPROVED
 * HERE** (`refuseWhatALeaverFiledHere`): its record is passed over once the
 * removal is approved, so no approval rests on it.
 *
 * **AN APPROVAL ALREADY COUNTED IS NOT OWED.** When the chain already holds this seat's approval of it (its own
 * approve, or its raise counted as its approval), it is refused as `ApprovalNotOwed('counted')`, with nothing built or
 * sent. One the chain has closed is owed none either: carried out, `ApprovalNotOwed('carried-out')`; withdrawn,
 * `NothingToApprove`. Every answer of the service is held to the proposal asked about (`theRoundAsked`).
 */
export async function approveOnDevice(
  doors: GovernedCallDoors, input: { round: RoundOnThePage; viewingKey: KeysHeld },
): Promise<RoundOnThePage> {
  const done = await approveHere(doors, input, false);
  if (done.counted) throw new ApprovalNotOwed('counted');
  return done.round;
}

/**
 * An approval as `approveOnDevice` builds it; a governance change only from `governOnDevice`, bound to the change it
 * checked. `counted` when the chain already held this seat's approval of it open, so nothing was built or sent; the
 * proposal then stands where the chain read it. Closed on the chain, it is refused before anything is built.
 */
async function approveHere(
  doors: GovernedCallDoors,
  input: {
    round: RoundOnThePage; viewingKey: KeysHeld;
    /** For a governance change: what it changes and its salt, which the approval is refused unless it matches. */
    of?: { governance: GovernanceOnTheWire; proposalSalt: string };
    /** For a removal: this seat's signature over the retirement it carries, sent with the approval. */
    retirement?: RetirementSignature;
  },
  aChangeCheckedHere: boolean,
): Promise<{ readonly counted: boolean; readonly round: RoundOnThePage }> {
  const { service } = doors;
  const named = theRoundAsked(await service.standing(input.round.id), input.round.id);
  /* The proposal proved is the one the person was shown, or nothing is built. */
  if (String(named.chainId).toLowerCase() !== String(input.round.chainId).toLowerCase()) {
    throw new Error('the company now names another proposal than the one shown here. Nothing was built or sent.');
  }
  const opened = await opensFor(doors)(input.round.id, input.viewingKey, false);
  if (String(opened.chainId).toLowerCase() !== String(input.round.chainId).toLowerCase()) {
    throw new Error('the company\'s record of this proposal does not match the proposal on this page. Nothing was built or '
      + 'sent. Reload the page and try again. If it happens again, do not approve it.');
  }
  if (input.round.summary !== undefined && opened.summary !== input.round.summary) {
    throw new Error('the company\'s record of this proposal says something different from what this page shows. Nothing '
      + 'was built or sent. Reload the page and try again. If it happens again, do not approve it.');
  }
  if (opened.governance !== undefined && !aChangeCheckedHere) {
    throw new Error('this proposal changes the company - who is seated, or how many approvals are needed - and such a change '
      + 'is approved where it is made, where this device first checks what it does. Nothing was built or sent.');
  }
  /* A change is checked for who filed it where it is made (`governOnDevice`); a run is checked here. */
  if (!aChangeCheckedHere) await refuseWhatALeaverFiledHere(doors, input.viewingKey, input.round.id, opened);
  doors.progress?.('reading-the-chain');
  /* Whether this seat's approval is already counted is the chain's answer, never the service's. */
  const before = await onChainHere(doors, named);
  if (before.approvedHere === undefined) {
    throw new Error('whether your approval of this proposal is already counted was not read from the chain, so nothing was built or '
      + 'sent. Reload the page and try again.');
  }
  /*
   * Closed on the chain, it is owed no approval: the chain keeps this seat's approval marker after it closes, so an
   * approval already counted is never read from a closed proposal, and nothing is built for one.
   */
  if (before.status === 'executed') throw new ApprovalNotOwed('carried-out');
  if (before.status !== 'open') throw new NothingToApprove();
  if (before.approvedHere) return { counted: true, round: before };
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account,
    order: { circuit: 'approve', proposal: opened.chainId, ...(input.of === undefined ? {} : { of: input.of }) },
    material: doors.material, chain, opened,
  });
  doors.progress?.('sending');
  const answer = await handedOver(doors.handOver, {
    tx, call: { kind: 'account-call', contract: chain.account, circuit: 'approve' },
    viaService: () => service.approve(input.round.id, {
      tx, filer: filerHere(doors), ...(input.retirement === undefined ? {} : { retirement: input.retirement }),
    }),
    /* A removal's retirement signature is kept only by the service, so it is handed there before the approval goes. */
    before: async () => { if (input.retirement !== undefined) await retirementHanded(doors, input.round, input.retirement); },
    after: () => service.standing(input.round.id),
  });
  const sent = await onChainHere(doors, theRoundAsked(answer, input.round.id, opened.chainId));
  /* This seat's own approval, never a count another signer's approval can also raise, or the proposal closed. */
  const seen = (r: RoundOnThePage) => r.approvedHere === true || r.status !== 'open';
  const now = seen(sent) ? sent : await waitFor(doors, 'your approval', input.round.id, seen, sent);
  if (now.status === 'cancelled') throw new WithdrawnWhileSent();
  return { counted: false, round: now };
}

/**
 * Hands this seat's signature over a removal's retirement to the service on its own, through the route that takes one,
 * as a raise that counted this seat's approval leaves no approval to carry it.
 */
const retirementHanded = async (doors: GovernedCallDoors, round: RoundOnThePage, signature: RetirementSignature): Promise<void> => {
  if (doors.service.retire === undefined) {
    throw new Error('the removal is raised, and this page cannot send your signature over its retirement, which the removal needs before '
      + 'it is carried out. Reload the page to get the current version, then make the removal again: it signs the retirement again.');
  }
  await doors.service.retire(round.id, { signature, filer: filerHere(doors) });
};

/** A proposal withdrawn while this device's approval of it was on its way: sent, and closed, so nothing is left to do. */
export class WithdrawnWhileSent extends Error {
  readonly nothingWasSent = false;
  constructor() {
    super('this proposal was withdrawn while this approval was being sent. Your approval was sent, and the proposal is closed, '
      + 'so there is nothing more to approve.');
    this.name = 'WithdrawnWhileSent';
  }
}

/** Why this device refuses a withdrawal before anything is built or sent: each in words the person can act on. */
export type WithdrawalStop =
  'closed' | 'started' | 'sent-not-yet-seen' | 'filed-by-another' | 'not-raised-here' | 'raiser-not-read' | 'retirement-filed'
  | 'chain-time-not-read' | 'started-may-be-paid' | 'started-charged' | 'clock-ahead' | 'may-still-land';

const WITHDRAWAL_STOPS: Readonly<Record<WithdrawalStop, string>> = {
  closed: 'the chain no longer holds this proposal: it was carried out, withdrawn or closed already, so there is nothing to withdraw.',
  started: 'this run\'s time to be paid has begun, and from then on the chain lets nobody withdraw it. It does not have the '
    + 'approvals it was raised needing: leave it unapproved, and it closes when its time ends.',
  'started-may-be-paid': 'this run\'s time to be paid has begun, and from then on the chain lets nobody withdraw it. It has the '
    + 'approvals it was raised needing, or this wallet could not read how many it needs, so it may be paid now with no other '
    + 'approval. A signer whose seat may hold runs on its vault can still hold it on the chain until it is '
    + 'charged or paid.',
  'started-charged': 'this run has been charged to its period and can be paid, so the chain lets nobody withdraw it or hold it.',
  'clock-ahead': 'this device\'s clock is ahead of the chain\'s time. The chain would still take this run\'s withdrawal, but this '
    + 'device checks the withdrawal against its own clock as it builds it, and by that clock the run\'s time to be paid has begun. '
    + 'Set this device\'s clock right and try again.',
  'sent-not-yet-seen': 'this proposal was sent to the chain and the chain does not show it yet, so it may still arrive. Wait until '
    + 'the chain shows it, then withdraw it.',
  'may-still-land': 'the chain does not show this proposal, and a raise of it sent from a device may still reach the chain '
    + 'until {until}, by the chain\'s time. Withdrawn now, the company\'s records would say it is withdrawn while the chain may '
    + 'still open it. Withdraw it after that time.',
  'filed-by-another': 'another signer wrote this proposal down and it has not been sent to the chain. Only the signer who wrote it '
    + 'down withdraws it before then: ask them.',
  'not-raised-here': 'this change to the company was raised by another signer, and the chain lets only the signer who raised it '
    + 'withdraw it: ask them.',
  'retirement-filed': 'the signer this removal takes off is already written down as retired in the company\'s directory, ready '
    + 'for the removal to be carried out. Withdrawn now, the directory would say they left while the chain still seats them, '
    + 'and every later change to the company would be refused. Carry the removal out instead.',
  'raiser-not-read': 'this wallet could not read from the chain who raised this proposal, so it cannot tell whether the chain '
    + 'would take your withdrawal. Reload and try again.',
  'chain-time-not-read': 'this wallet could not read the chain\'s time, so it cannot tell whether a run\'s time to be paid '
    + 'has begun, from when the chain takes no withdrawal of it, or whether a raise of a proposal the chain does not show may '
    + 'still reach it. Reload and try again.',
};

/** A withdrawal this device refused before anything was built or sent, naming why. */
export class WithdrawalRefused extends Error {
  readonly nothingWasSent = true;
  /** For `may-still-land`: the chain time, as an ISO date, until which a raise of the proposal may still land. */
  readonly until?: string;
  constructor(readonly why: WithdrawalStop, until?: string) {
    super(`${WITHDRAWAL_STOPS[why].replace(/^./u, (c) => c.toUpperCase()).replace('{until}', until ?? '')} Nothing was sent.`);
    this.name = 'WithdrawalRefused';
    if (until !== undefined) this.until = until;
  }
}

/**
 * Where a withdrawal sent from this device left the proposal, as the chain shows it once it no longer holds it:
 *   - `withdrawn`: the call that closed it is a withdrawal, read from that call's own operations in its transaction
 *     (`closedBy`, `roundsOnChainIn`); another proposal's calls in the same block are not this one's;
 *   - `withdrawn-or-closed`: the calls of that block were not read one by one (a history that carries no transaction
 *     bytes) and the withdrawal is among them beside other calls, so whether it or another of them closed this one is
 *     not told here; it is closed either way;
 *   - `closed-otherwise`: the call that closed it is no withdrawal: it was carried out or closed before the withdrawal
 *     landed, and the withdrawal changed nothing;
 *   - `records-withdrawn-not-on-chain`: the chain does not hold it now, and the company's records now mark it withdrawn.
 *     Never reported as withdrawn: that no raise of it was sent rests on the service's word, and the service relays
 *     raises, so one it held may still land open. Its raiser can then withdraw it on the chain; a run also stops being
 *     payable once its window closes, but a change to the company has no window, so only that withdrawal closes it.
 */
export type WithdrawalOutcome = 'withdrawn' | 'withdrawn-or-closed' | 'closed-otherwise' | 'records-withdrawn-not-on-chain';

/** The chain's time in milliseconds, or a refusal: a time that was not read, or is not a whole positive number, decides nothing. */
const chainTimeRead = async (read: (() => Promise<number>) | undefined): Promise<number> => {
  const at = read === undefined ? undefined : await read().catch(() => undefined);
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) throw new WithdrawalRefused('chain-time-not-read');
  return at;
};

/**
 * Why a run whose time to be paid has begun is not withdrawn, by where it stands: charged to its period, short of the
 * approvals its hold says it was raised needing (or holding none), or able to be paid, where only a hold stops it.
 */
const startedStop = (onChain: RoundOnChain): WithdrawalStop => {
  if (onChain.held === 'cleared') return 'started-charged';
  const short = onChain.approvals === 0 || (onChain.needed !== undefined && onChain.approvals < onChain.needed);
  return short ? 'started' : 'started-may-be-paid';
};

/* The contract's own refusal of a run's withdrawal once its time to be paid has begun. */
const RUN_STARTED = /that run has already started/u;

const outcomeOfAClose = (closedBy: readonly string[]): WithdrawalOutcome => {
  if (!closedBy.includes('cancel')) return 'closed-otherwise';
  return closedBy.every((c) => c === 'cancel') ? 'withdrawn' : 'withdrawn-or-closed';
};

/**
 * **A PROPOSAL WITHDRAWN FROM THIS DEVICE.** The proposal is opened from the company's records for a withdrawal
 * (`openTheRoundHere`): believed as its filer filed it, its identity the one its own record makes. Where it stands is
 * read from the chain, through the person's own wallet, with this seat, and the withdrawal is refused before anything is
 * built or sent unless the chain would take it: a run only before its time to be paid begins, by any signer; any other
 * proposal only by the seat that raised it (`raisedHere`, the withdraw key its hold carries). `check` is the caller's
 * own refusal of the kind it opened. A removal whose leaving seat the directory already shows retired is refused. One the
 * chain does not hold is marked withdrawn in the company's records with no call, only by the seat that wrote it down, only
 * once the chain's time has passed the deadline its raise carries (`raiseBy`), and reported as exactly that, never as
 * withdrawn; one the service says was sent and the chain does not show yet is refused until the chain's time passes
 * that deadline, and then it is marked withdrawn the same way, since no raise of it can land. A
 * withdrawal sent is waited on until the chain no longer holds the proposal, and the outcome is the chain's.
 *
 * Whether a run's time to be paid has begun is judged by `chainTime`, the time of the newest block at the indexer the
 * person's own wallet names, in milliseconds, which may be hours off this device's clock. It is read for a run and for a
 * proposal the chain does not hold, and either is refused when it is not read. The cancel itself is still run on this device against this
 * device's clock as it is built, so a clock ahead of the chain's is refused with words saying so. The chain judges the
 * withdrawal against the block it lands in, later than the newest block read here, so one sent just before a run's
 * time begins may still be refused by the chain, and costs only its fee. A run whose time has begun is refused with
 * words that say where it stands (`startedStop`).
 */
export async function withdrawOnDevice(
  doors: GovernedCallDoors,
  input: {
    round: { readonly id: string; readonly chainId?: string }; viewingKey: KeysHeld;
    chainTime?: () => Promise<number>;
    check?: (opened: OpenedRound, onChain: RoundOnChain) => void;
  },
): Promise<RoundOnThePage & { readonly withdrawal: WithdrawalOutcome }> {
  const { service } = doors;
  if (service.cancel === undefined) {
    throw new Error('This page cannot withdraw proposals. Reload the page to get the current version. Nothing was sent.');
  }
  const served = theRoundAsked(await service.standing(input.round.id), input.round.id, input.round.chainId);
  const opened = await openTheRoundHere(doors.service, doors.accountId, input.round.id, input.viewingKey, false, doors.records, doors.leaves, true);
  if (String(opened.chainId).toLowerCase() !== String(served.chainId).toLowerCase()) {
    throw new Error('the company now names another proposal than the one shown here. Nothing was built or sent.');
  }
  const chainId = String(opened.chainId).toLowerCase();
  if (doors.records?.roundsOnChain === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read where the company\'s proposals stand on the chain, so it cannot '
      + 'withdraw one. Reload the page to get the current version.');
  }
  doors.progress?.('reading-the-chain');
  const onChain = (await doors.records.roundsOnChain([chainId]))[chainId];
  if (onChain === undefined) {
    throw new NotOpenedOnThisDevice('Where this proposal stands on the chain was not read, so nothing is decided from it. '
      + 'Reload the page and try again.');
  }
  input.check?.(opened, onChain);
  /*
   * A removal whose leaving seat's retirement is already filed (filed before the removal is carried out) is never
   * withdrawn: the directory would say retired while the chain seats them, and no record is rewritten to undo it.
   */
  if (opened.removes !== undefined) {
    const here = await doors.records.directory();
    if (here.dir.seats.some((x) => String(x.seat).toLowerCase() === opened.removes && x.retired !== null)) {
      throw new WithdrawalRefused('retirement-filed');
    }
  }
  if (onChain.held === 'closed') throw new WithdrawalRefused('closed');
  if (onChain.held === 'cleared') throw new WithdrawalRefused(startedStop(onChain));
  if (onChain.held === 'never') {
    /*
     * A raise of it may be on its way from any device, sent through the service or not, and the chain takes one until its
     * deadline, `raiseBy`, which the proposal's signed record fixes. Past it by the chain's own time none can ever land,
     * so the records may say withdrawn whatever the service says it sent; before it, or with the chain's time unread, a
     * raise the service says it sent is waited for, and one written down only by this seat is refused until that time.
     */
    const sent = served.txRef !== undefined || served.raisedAt !== undefined;
    const mine = String(opened.filedBy ?? '').toLowerCase() === filerHere(doors).toLowerCase();
    const raiseByMs = opened.raiseBy === undefined ? undefined : Number(opened.raiseBy) * 1000;
    const chainNow = raiseByMs === undefined ? undefined : await chainTimeRead(input.chainTime).catch(() => undefined);
    if (raiseByMs === undefined || chainNow === undefined || raiseMayStillLandAt(opened.raiseBy!, chainNow)) {
      if (sent) throw new WithdrawalRefused('sent-not-yet-seen');
      if (!mine) throw new WithdrawalRefused('filed-by-another');
      if (raiseByMs === undefined) {
        throw new NotOpenedOnThisDevice('This proposal\'s record does not say when it was written down, so this device cannot tell until '
          + 'when a raise of it may still reach the chain. Write the change down again from this device, and withdraw this one once the '
          + 'new one is on the chain.');
      }
      if (chainNow === undefined) throw new WithdrawalRefused('chain-time-not-read');
      throw new WithdrawalRefused('may-still-land', new Date(raiseByMs).toISOString());
    }
    if (!mine) throw new WithdrawalRefused('filed-by-another');
    /*
     * Where the chain stood was read before its time. A raise that landed in a block before the deadline shows in any
     * read made after a block at or past it, so where it stands is read again now, and the records say withdrawn only
     * if the chain still never held it.
     */
    const again = (await doors.records.roundsOnChain([chainId]))[chainId];
    if (again === undefined) {
      throw new NotOpenedOnThisDevice('Where this proposal stands on the chain was not read again after the chain\'s time, so it is not '
        + 'withdrawn. Nothing was withdrawn. Reload the page and try again.');
    }
    if (again.held !== 'never') {
      throw new NotOpenedOnThisDevice('the chain now shows this proposal, which it did not when first read, so it is not withdrawn here. '
        + 'Nothing was withdrawn. Open it again to see where it stands.');
    }
    const answer = theRoundAsked(await service.cancel(input.round.id, { filer: filerHere(doors) }), input.round.id, chainId);
    if (answer.status !== 'cancelled') {
      throw new Error('the company\'s records did not mark this proposal withdrawn. Open it again to see where it stands.');
    }
    return { ...answer, withdrawal: 'records-withdrawn-not-on-chain' };
  }
  if (onChain.opensAt !== undefined) {
    const chainNow = await chainTimeRead(input.chainTime);
    if (onChain.opensAt * 1000 <= chainNow) throw new WithdrawalRefused(startedStop(onChain));
  } else if (onChain.raisedHere === undefined) {
    throw new WithdrawalRefused('raiser-not-read');
  } else if (!onChain.raisedHere) {
    throw new WithdrawalRefused('not-raised-here');
  }
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  /*
   * The cancel is run on this device before it is proved, and that run checks a run's window against this device's
   * clock, since no block time can be handed to it. The chain's time already said the window has not opened, so the
   * contract's own refusal here means this device's clock is ahead of the chain's.
   */
  const { tx } = await doors.builder.governedCall({
    account: chain.account, order: { circuit: 'cancel', proposal: opened.chainId }, material: doors.material, chain, opened,
  }).catch((e: unknown) => {
    if (onChain.opensAt !== undefined && RUN_STARTED.test(String((e as { message?: unknown } | null)?.message ?? e))) {
      throw new WithdrawalRefused('clock-ahead');
    }
    throw e;
  });
  doors.progress?.('sending');
  const sent = theRoundAsked(await handedOver(doors.handOver, {
    tx, call: { kind: 'account-call', contract: chain.account, circuit: 'cancel' },
    viaService: () => service.cancel!(input.round.id, { tx, filer: filerHere(doors) }),
    before: async () => { closesOnRecord(service); },
    after: () => service.standing(input.round.id),
  }), input.round.id, chainId);
  const gone = (r: RoundOnChain | undefined): r is RoundOnChain => r !== undefined && r.held !== 'open' && r.held !== 'cleared';
  const sleep = doors.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = doors.waitMs ?? 5 * 60_000;
  const everyMs = doors.everyMs ?? 6_000;
  let now: RoundOnChain | undefined = (await doors.records.roundsOnChain([chainId]))[chainId];
  for (let waited = 0; !gone(now) && waited < waitMs; waited += everyMs) {
    doors.progress?.('waiting-for-the-chain');
    await sleep(everyMs);
    try {
      now = (await doors.records.roundsOnChain([chainId]))[chainId];
    } catch {
      /* A read that failed decides nothing: the chain is asked again. */
    }
  }
  if (!gone(now)) throw new SentAndNotYetSeen('Your withdrawal', sent);
  const withdrawal = outcomeOfAClose(now.closedBy ?? []);
  /* Sent any way but through our service, our service's record is closed from its own read of the chain once it is gone. */
  const kept = notThroughOurService(doors.handOver) && withdrawal === 'withdrawn'
    ? await closedOnRecord(service, input.round.id, chainId, filerHere(doors), 'withdrawn').catch(() => sent)
    : sent;
  const standing = await onChainHere(doors, kept);
  return { ...standing, withdrawal };
}

type Api = (path: string, init?: RequestInit) => Promise<any>;

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

/** The service's routes, over this page's own sign-in. No secret travels in any of them: a relay names only its seat's public filing key. */
export const governedCallServiceFor = (api: Api): GovernedCallService => {
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const proposal = (id: string) => `/api/proposals/${encodeURIComponent(id)}`;
  const account = (id: string) => `/api/accounts/${encodeURIComponent(id)}`;
  return {
    callState: (accountId) => api(`${account(accountId)}/call-state`),
    send: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/send`, body)),
    approve: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/approve`, body)),
    retire: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/retirement`, body)),
    standing: (proposalId) => post(`${proposal(proposalId)}/standing`, {}),
    cancel: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/cancel`, body)),
    file: (accountId, body) => marked(() => post(`${account(accountId)}/proposals`, body)),
    carry: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/carry`, body)),
    charge: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/charge`, body)),
    closed: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/closed`, body)),
    sealedProposals: (accountId) => api(`${account(accountId)}/proposals`),
    sealedAccount: (accountId) => api(account(accountId)),
  };
};

/* ── A GOVERNANCE CHANGE, RAISED, APPROVED AND CARRIED OUT FROM THIS DEVICE ──── */

/** Where a governance change stands after this device has done what it can. */
export type GovernedOutcome =
  | { readonly state: 'done'; readonly round: RoundOnThePage | null }
  | { readonly state: 'waiting-for-approvals'; readonly round: RoundOnThePage }
  /** An invitation approved: the invitee takes the seat from their own wallet, never this device. */
  | { readonly state: 'waiting-for-the-invitee'; readonly round: RoundOnThePage }
  /** At its bar, and left for the one step that carries a change out (`stopBeforeCarry`). */
  | { readonly state: 'ready-to-carry'; readonly round: RoundOnThePage };

/**
 * The changes this device raises, approves and carries out through the company's
 * records (`governOnDevice`). A recovery of the record anchor never is: it runs
 * while those records are stopped, from the chain and a file its raiser hands
 * over (`records-recovered-here.ts`). Nor is a vault's retire, which the vault
 * itself carries out once it holds no money (`carryRetireHere`).
 */
type GovernedThroughTheRecords = Exclude<GovernanceOnTheWire, { readonly kind: 'recover-anchor' } | { readonly kind: 'retire-vault' }>;

/** Each change's kind, as a proposal's sealed record names it. */
const KIND_OF: Readonly<Record<GovernedThroughTheRecords['kind'],
  'add-signer' | 'remove-signer' | 'set-threshold' | 'set-vault-threshold' | 'set-spending-policy' | 'set-policy-bar'>> = {
  'add-signer': 'add-signer', 'remove-signer': 'remove-signer', threshold: 'set-threshold', 'vault-threshold': 'set-vault-threshold',
  'spending-policy': 'set-spending-policy', 'policy-bar': 'set-policy-bar',
};

/** The circuit that carries each change out. */
const CARRIED_BY: Readonly<Record<GovernedThroughTheRecords['kind'], CarryCircuit | null>> = {
  'add-signer': null, 'remove-signer': 'removeSignerAndSetThreshold', threshold: 'setThreshold', 'vault-threshold': 'setVaultThreshold',
  'spending-policy': 'setPolicy', 'policy-bar': 'setPolicyBar',
};

/**
 * **THE PROPOSAL THE COMPANY ALREADY HOLDS FOR THIS CHANGE, OPENED HERE**:
 * open, written down with the salt its identity is made with, and for exactly
 * this change. The one the chain holds first, then the newest; given `proposal`,
 * only the one with that identity on the chain, so a record another seat filed
 * for the same change is never taken up in its place. Null when there is none,
 * and a new one is written down.
 */
async function liveRoundHere(
  doors: GovernanceDoors, viewingKey: KeysHeld, change: GovernanceOnTheWire, proposal?: string,
): Promise<{ round: RoundOnThePage; opened: OpenedRound; filed: SealedProposal; enteredNow: boolean } | null> {
  const { service } = doors;
  if (!service.sealedProposals) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot find this change. Reload the '
      + 'page to get the current version.');
  }
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot find this change. Reload the '
      + 'page to get the current version.');
  }
  /*
   * Every proposal the company's records name must be in the list: one withheld is never a change with no proposal yet
   * (`listedHere`); and each stands where the chain says it does, never where the service's plain fields say.
   */
  const served = await service.sealedProposals(doors.accountId);
  const listed = await standingOnChainHere(doors.records, listedHere(await doors.records.directory(kindAsked('proposal')), 'proposal', served, 'proposal'));
  const candidates = listed
    .filter((p) => p.accountId === doors.accountId && p.status === 'open' && (proposal === undefined || String(p.chainId).toLowerCase() === proposal.toLowerCase()))
    .sort((a, b) => (a.raisedAt ? 0 : 1) - (b.raisedAt ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  const own = signingPublicKeyOf(doors.material.signingSecret as Hex);
  /* An entry of this seat's own that the company's records would not keep: said rather than raising the change twice. */
  let notEntered: unknown = null;
  for (const p of candidates) {
    let opened: OpenedRound;
    let enteredNow = false;
    try {
      opened = await opensFor(doors)(p.id, viewingKey, false);
    } catch (e) {
      /*
       * One that opened as a kind this page does not act on - a new vault's adoption or first secret run, set up
       * from the vault itself - can never be the change asked for, so it is passed over. One that did not open
       * at all still says so below.
       */
      if (e instanceof NotOpenedOnThisDevice && e.kind !== undefined) continue;
      /*
       * A proposal this seat wrote down is not opened while no entry names it, so one whose entry was not kept is
       * entered here, by its filer, and opened again. Another seat's is its own filer's to enter.
       */
      if (p.filedBy?.publicKey.toLowerCase() !== own || proposalFilingRefusal(doors.accountId, p) !== null) continue;
      try {
        await proposalEntered(doors, proposalEntry(doors.accountId, p));
        enteredNow = true;
        opened = await opensFor(doors)(p.id, viewingKey, false);
      } catch (e) {
        notEntered ??= e;
        continue;
      }
    }
    if (opened.governance === undefined || !('kind' in opened.governance)) continue;
    if (!sameGovernance(opened.governance as GovernanceOnTheWire, change)) continue;
    return { round: { id: p.id, chainId: p.chainId, status: p.status, approvalCount: p.approvalCount,
      ...(p.txRef === undefined ? {} : { txRef: p.txRef }), ...(p.raisedAt === undefined ? {} : { raisedAt: p.raisedAt }),
      ...((p as { readonly outrun?: true }).outrun === true ? { outrun: true as const } : {}) }, opened, filed: p, enteredNow };
  }
  if (notEntered !== null) throw notEntered;
  return null;
}

/** The account's own name for no asset, which a governance proposal's raise names: nothing moves. */
const NO_ASSET_NAMED = { assetId: assetIdBytes(NO_ASSET) };

/**
 * A proposal's raise half for a governance change: no asset, nothing moved, the
 * salt its identity is made with, and the account's asset blinding from the
 * company state its founding seat signed, which the raise commits its change with.
 */
const governanceHalf = (salt: string, opened: OpenedRound, assetBlinding: string) => ({
  assetId: opened.half?.assetId ?? hexOfBytes(NO_ASSET_NAMED.assetId),
  assetBlinding,
  proposalSalt: salt,
  changeAmount: opened.half?.changeAmount ?? '0',
  changeBatchDigest: opened.half?.changeBatchDigest ?? commit('', ''),
});

/**
 * Whether the chain's count for a governance proposal meets the bar it is
 * carried out at - never for one the chain has closed (`counted`) - from the approvals the account asks for as the person's own
 * wallet read them (`AccountGovernance`), never from the company's service: for
 * a signer seated or removed, the approvals a change of who is seated needs, as the
 * account's own `requireSeatBar` holds it; for a vault's threshold, the bar
 * `setVaultThreshold` carries it out at (`thresholdCarryBar`); for a change carried
 * out at another bar, `bar` of what the account holds; otherwise the account's own
 * threshold - and never less than the approvals the proposal held when it was
 * raised, as the chain reads it (`requireApproved`), so a threshold lowered since
 * never lets an approval be skipped as met.
 * A read without the seat bar is refused, never taken as no bar. Only whether
 * to try: the chain refuses a carrying out short of its bar whatever this says.
 */
const meetsTheBar = async (
  doors: GovernedCallDoors, round: RoundOnThePage, change: GovernedThroughTheRecords, bar?: (held: AccountGovernance) => number,
): Promise<boolean> => {
  if (doors.records === undefined) return false;
  const held = (await doors.records.directory()).holders;
  if (!Number.isSafeInteger(held?.seatBar) || held.seatBar < 1) {
    throw new Error('your wallet\'s read of the company\'s account did not say how many approvals a change of who is seated needs, '
      + 'so this device cannot say whether the proposal has the approvals it needs. Nothing was sent. Reload the page.');
  }
  const needed = bar !== undefined ? bar(held)
    : change.kind === 'add-signer' || change.kind === 'remove-signer' ? held.seatBar
      : change.kind === 'vault-threshold' ? thresholdCarryBar({ kind: 'vaultThreshold', vault: change.vault as Hex, threshold: Number(change.threshold) }, held)
        : held.approvals;
  const asked = String(round.chainId).toLowerCase();
  const onChain = doors.records.roundsOnChain === undefined ? undefined : (await doors.records.roundsOnChain([asked]))[asked];
  return counted(round) >= Math.max(needed, onChain?.needed ?? 0);
};

/**
 * **NO SIGNER IS SEATED BESIDE THE FOUNDING SIGNER BEFORE THE COMPANY IS
 * FOUNDED ON CHAIN** (`foundedOnChainHere`): the company's founding seat is read
 * from its first anchor, which must be made while that seat is the account's
 * only one and must hold the company's first state and first roster. Refused,
 * saying what resolves it, before a seat is raised, approved or carried out.
 */
async function refuseASecondSignerBeforeTheFounding(doors: GovernanceDoors): Promise<void> {
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot seat a signer. Reload the page to '
      + 'get the current version.');
  }
  const why = foundedOnChainHere(await doors.records.directory(FOUNDING_ASKED));
  if (why !== null) {
    throw new Error(`No signer is added before the records the company was founded with are anchored on chain (${why}). `
      + 'Nothing was sent. Open the company on its founding signer\'s device to anchor them, then add the signer again.');
  }
}

/**
 * **A GOVERNANCE CHANGE TAKEN AS FAR AS THIS DEVICE CAN TAKE IT.** The
 * proposal the company already holds for it is used; with none, one is written
 * down here - sealed under the company's key in force and signed by this seat -
 * and raised. It is approved by this signer if they have not approved it, and
 * carried out once the chain counts the approvals it needs. A proposal still
 * short of approvals is left for the others to approve from their own devices,
 * and said so. `before` is the check this device makes before it raises, sends,
 * approves or carries out the change; it refuses by throwing. A device asked only to
 * approve (`approveOnly`) writes nothing down and raises nothing, and refuses
 * an approval the chain already counts for its seat (`ApprovalNotOwed`). The
 * checks run before every send: the raise, a raise written down and sent again,
 * the approval and the carrying out. `stopBeforeCarry` ends at the bar, leaving the
 * carrying out to its own step; `carryOnly` carries out a proposal at its bar and
 * approves nothing.
 */
async function governOnDevice(
  doors: GovernanceDoors,
  input: {
    viewingKey: KeysHeld; change: GovernedThroughTheRecords; summary: string; body: GovernancePayloadBody;
    /** Given the proposal as this device opened it, at the approval and the carrying out; given nothing before a raise or a raise sent again. */
    before?: (opened?: OpenedRound) => Promise<void>;
    /** For a removal: this seat's signature over the retirement the opened proposal carries, sent with its approval. */
    signs?: (opened: OpenedRound, round: RoundOnThePage) => Promise<RetirementSignature | undefined>;
    /** What must stand before the chain is asked to carry the change out, after every other check: a removal's retirement, anchored. */
    beforeCarry?: (opened: OpenedRound, round: RoundOnThePage) => Promise<void>;
    /** For a change carried out at a bar other than the account's threshold: that bar, from the approvals the account asks for. */
    bar?: (held: AccountGovernance) => number;
    /**
     * For a spending policy: its highest band, from its own terms. Carrying it out raises the approvals a change of who
     * is seated needs to that many, which the proposal itself does not say.
     */
    highestBand?: number;
    /**
     * For a spending policy: the highest band of every policy in force on the company's vaults that this device opens,
     * read afresh at each check. Without it, or without `highestBand`, a spending policy is refused.
     */
    bandsInForce?: () => Promise<readonly BandInForce[]>;
    /** For a change whose carrying out reads more than the proposal holds: the order, made from the proposal opened. */
    carry?: (opened: OpenedRound) => GovernedCallOrder;
    /**
     * For a device that only approves: the identity on the chain of the one proposal it may approve. It then raises
     * nothing, and refuses with nothing sent unless the company holds exactly that proposal, raised on the chain.
     */
    approveOnly?: string;
    /** The identity on the chain of the one proposal this change may take up, raise or approve; any other is passed over. */
    proposal?: string;
    /** Ends once the proposal is at its bar, before it is carried out: the carrying out is a step of its own. */
    stopBeforeCarry?: boolean;
    /** Only carries out, with `approveOnly` naming the proposal: one short of its bar is left waiting and not approved. */
    carryOnly?: boolean;
    /**
     * Who the seat an invitation adds counts as approving, from its role's rights on the vaults it names (`invitedSeatRightsOf`):
     * given for an invitation that sets a threshold. Without it, such an invitation is refused.
     */
    seatRights?: SeatRights;
  },
): Promise<GovernedOutcome> {
  const { service } = doors;
  /*
   * **NO CHANGE THIS DEVICE RAISES, APPROVES OR CARRIES OUT LEAVES A VAULT
   * UNABLE TO PAY**: counted afresh before each, over the company as it stands
   * then, a spending policy at its bands, as well as any check the caller makes. Approved or carried out, it is
   * also refused when its seat filed it after its own removal was raised
   * (`refuseWhatALeaverFiledHere`).
   */
  const check = async (opened?: OpenedRound, proposalId?: string): Promise<void> => {
    const counts = changeCounted(input.change, input.seatRights);
    if (counts?.kind === 'seatAndThreshold') await refuseASeatThresholdHere(doors, counts);
    else if (counts?.kind === 'remove' || counts?.kind === 'removeAndThreshold') {
      refuseLeavingAVaultShort(await removalApproversHere(doors, input.viewingKey), counts, doors.vaultName);
    } else if (counts !== null) refuseLeavingAVaultShort(await doors.approvers(), counts, doors.vaultName);
    if (input.change.kind === 'add-signer') await refuseASecondSignerBeforeTheFounding(doors);
    await refuseABarRaisedDuringARemoval(doors, input.viewingKey, input.change, input.highestBand);
    if (input.change.kind === 'spending-policy') await refuseAPolicyLeavingAVaultShort(doors, input.change.vault, input.highestBand, input.bandsInForce);
    if (opened !== undefined && proposalId !== undefined) await refuseWhatALeaverFiledHere(doors, input.viewingKey, proposalId, opened);
    await input.before?.(opened);
  };
  const key = input.viewingKey;
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot raise or carry out this '
      + 'change. Reload the page to get the current version.');
  }
  const records = doors.records;
  const blinding = async (): Promise<string> => (await signedStateHere(records, doors.accountId, key)).assetBlinding;
  const found = await liveRoundHere(doors, input.viewingKey, input.change, input.proposal);
  /*
   * **A PROPOSAL THIS SEAT WROTE DOWN IS ENTERED BY THIS SEAT, ON EVERY
   * ATTEMPT.** An entry not kept the first time is made again here, so making
   * the change again is what puts it in the company's records; one kept already
   * is answered as entered. Another seat's proposal is its own filer's to enter.
   */
  if (found !== null && !found.enteredNow && found.filed.filedBy?.publicKey.toLowerCase() === signingPublicKeyOf(doors.material.signingSecret as Hex)) {
    await proposalEntered(doors, proposalEntry(doors.accountId, found.filed));
  }
  let live: { round: RoundOnThePage; opened: OpenedRound } | null = found;
  /* Whether this attempt sent the raise: a raise counts as its raiser's approval on the chain. */
  let raisedHere = false;
  /* A device that only approves sends no raise: not a new proposal, and not one the company holds that the chain has not raised. */
  if (input.approveOnly !== undefined && (live === null || !live.round.raisedAt
    || String(live.round.chainId).toLowerCase() !== input.approveOnly.toLowerCase())) {
    throw new NothingToApprove();
  }
  if (live === null) {
    if (!service.file) throw new Error('This page cannot write proposals down. Reload the page to get the current version. Nothing was sent.');
    await check();
    const salt = doors.filing.salt();
    const identity = await proposalIdentityOn(doors.builder)(input.change, salt);
    /* A signer invitation, by address or by a link or a code, names the proposal raised for it; raised under any other, every other device refuses it. */
    const terms = (input.body as { invited?: { terms?: { proposal?: unknown; leaf?: unknown } } }).invited?.terms;
    if (input.change.kind === 'add-signer' && typeof terms?.proposal === 'string'
      && terms.proposal.toLowerCase() !== String(identity.chainId).toLowerCase()) {
      throw new InvitationNotBound('The invitation this proposal carries names another proposal than this one, so nothing was raised. '
        + 'Nothing was sent. Invite the person again.');
    }
    const change = { asset: NO_ASSET, amount: 0n, batchDigest: commit('', ''), salt: salt as Hex };
    const sealing = sealingWith(key, doors.filing.keyEpoch);
    const filing = signProposalFiling(doors.accountId, {
      id: doors.filing.newId(), digest: identity.digest as Hex, chainId: identity.chainId as Hex, keyEpoch: sealing.epoch,
      createdAt: new Date().toISOString(),
      sealed: sealGovernanceProposal({
        accountId: doors.accountId, viewingKey: sealing.key, kind: KIND_OF[input.change.kind], summary: input.summary,
        noVault: identity.noVault as Hex, body: input.body, change, proposedBy: doors.filing.seat,
      }),
    }, doors.material.signingSecret as Hex);
    const raisedRetirement = (input.body as { retirement?: RetirementTerms }).retirement;
    const opened: OpenedRound = {
      chainId: identity.chainId, digest: identity.digest, vault: identity.noVault, salt, summary: input.summary, filedBy: filing.filedBy.publicKey,
      raiseBy: raiseByOf(filing.createdAt),
      governance: input.change, half: { assetId: hexOfBytes(NO_ASSET_NAMED.assetId), changeAmount: '0', changeBatchDigest: change.batchDigest },
      ...(raisedRetirement === undefined ? {} : { retirement: raisedRetirement }),
    };
    doors.progress?.('reading-the-chain');
    const chain = await service.callState(doors.accountId);
    doors.progress?.('building');
    const { tx } = await doors.builder.governedCall({
      account: chain.account, material: doors.material, chain, opened,
      order: { circuit: 'propose', governance: input.change, half: governanceHalf(salt, opened, await blinding()), proposal: identity.chainId },
    });
    doors.progress?.('sending');
    const file = service.file;
    const answer = await handedOver(doors.handOver, {
      tx, call: { kind: 'account-call', contract: chain.account, circuit: 'propose' },
      viaService: () => file(doors.accountId, { proposal: filing, tx, version: DEVICE_RAISE_VERSION, salt }),
      before: () => file(doors.accountId, { proposal: filing, salt }),
      after: () => service.standing(filing.id),
    });
    const sent = await onChainHere(doors, theRoundAsked(answer, filing.id, identity.chainId));
    await proposalEntered(doors, proposalEntry(doors.accountId, filing));
    const round = sent.raisedAt ? sent : await waitFor(doors, 'this proposal', filing.id, (r) => Boolean(r.raisedAt), sent);
    live = { round, opened };
    raisedHere = true;
  } else if (!live.round.raisedAt) {
    /* Opened again for a send: the half of its raise, the change it seals, is read only for one. */
    const { round } = live;
    const opened = await opensFor(doors)(round.id, input.viewingKey, true);
    /* Sent again, it is still a raise: checked as one before anything is built, and refused if a signer on their way out filed it. */
    await check();
    await refuseWhatALeaverFiledHere(doors, input.viewingKey, round.id, opened);
    doors.progress?.('reading-the-chain');
    const chain = await service.callState(doors.accountId);
    doors.progress?.('building');
    const { tx } = await doors.builder.governedCall({
      account: chain.account, material: doors.material, chain, opened,
      order: { circuit: 'propose', governance: input.change, half: governanceHalf(opened.salt, opened, await blinding()), proposal: opened.chainId },
    });
    doors.progress?.('sending');
    const answer = await handedOver(doors.handOver, {
      tx, call: { kind: 'account-call', contract: chain.account, circuit: 'propose' },
      viaService: () => service.send(round.id, { tx, version: DEVICE_RAISE_VERSION, filer: filerHere(doors) }),
      after: () => service.standing(round.id),
    });
    const sent = await onChainHere(doors, theRoundAsked(answer, round.id, opened.chainId));
    live = { round: sent.raisedAt ? sent : await waitFor(doors, 'this proposal', round.id, (r) => Boolean(r.raisedAt), sent), opened };
    raisedHere = true;
  }
  let { round } = live;
  const { opened } = live;
  const of = { governance: input.change, proposalSalt: opened.salt };
  /*
   * **A RAISE IS ITS RAISER'S APPROVAL, SO A REMOVAL'S RAISER SIGNS ITS RETIREMENT AT THE RAISE.** The chain counted this
   * seat when the raise landed, so no approval of its own follows to carry the signature: it is handed on its own, the
   * same signature through the route that takes one, before anybody carries the removal out.
   */
  if (raisedHere) {
    /* Every check an approval of it would make here runs first, so this seat signs only what it would approve. */
    await check(opened, round.id);
    const retirement = await input.signs?.(opened, round);
    if (retirement !== undefined) await retirementHanded(doors, round, retirement);
  }
  /* A seat that raised it here has nothing more to approve; one resuming, or another seat, approves. */
  if (!raisedHere && input.change.kind === 'add-signer' && round.outrun === true) throw new InvitationOutrun();
  if (!raisedHere && !(await meetsTheBar(doors, round, input.change, input.bar))) {
    if (input.carryOnly === true) return { state: 'waiting-for-approvals', round };
    await check(opened, round.id);
    const retirement = await input.signs?.(opened, round);
    const done = await approveHere(doors, { round, viewingKey: input.viewingKey, of, ...(retirement === undefined ? {} : { retirement }) }, true);
    if (!done.counted) {
      round = done.round;
    } else {
      /* Asked only to approve, an approval the chain already counts is refused as owed nothing, never told as sent. */
      if (input.approveOnly !== undefined) throw new ApprovalNotOwed('counted');
      /* The chain counts this seat's raise, sent on an earlier attempt, as its approval: its retirement signature goes on its own. */
      if (retirement !== undefined) await retirementHanded(doors, round, retirement);
      round = await standingHere(doors, round.id, round.chainId);
    }
  }
  if (!(await meetsTheBar(doors, round, input.change, input.bar))) return { state: 'waiting-for-approvals', round };
  const carryCircuit = CARRIED_BY[input.change.kind];
  if (carryCircuit === null) return { state: 'waiting-for-the-invitee', round };
  if (input.stopBeforeCarry === true) return { state: 'ready-to-carry', round };
  if (!service.carry) throw new Error('This page cannot carry out proposals. Reload the page to get the current version. Nothing was sent.');
  await check(opened, round.id);
  await input.beforeCarry?.(opened, round);
  /* What carries it out is made here, from the proposal as this device opened it. */
  const order = input.carry === undefined ? carryOrderHere(opened) : input.carry(opened);
  const carried = order as { circuit?: string; proposal?: string };
  if (carried.circuit !== carryCircuit || String(carried.proposal).toLowerCase() !== String(round.chainId).toLowerCase()) {
    throw new Error('the company\'s record of this proposal is not the change asked for here. Nothing was built or sent. '
      + 'Reload the page and try again.');
  }
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({ account: chain.account, order, material: doors.material, chain, opened });
  doors.progress?.('sending');
  const carry = service.carry;
  const done = theRoundAsked(await handedOver(doors.handOver, {
    tx, call: { kind: 'account-call', contract: chain.account, circuit: carryCircuit },
    viaService: () => carry(round.id, { tx, circuit: carryCircuit, filer: filerHere(doors) }),
    before: async () => { closesOnRecord(service); },
    after: () => closedOnTheChainHere(doors, round.id, round.chainId, 'carried'),
  }), round.id, round.chainId);
  return { state: 'done', round: done };
}

/**
 * **THIS SEAT'S PROPOSAL ENTERED IN THE COMPANY'S RECORDS**, or refused in the
 * words that fix it: the proposal is written down and raised, and making the
 * change again from this page enters it.
 */
async function proposalEntered(doors: GovernanceDoors, entry: ManifestEntryBody): Promise<void> {
  try {
    await doors.filing.entered.enter([entry]);
  } catch (e) {
    if (!(e instanceof FiledNotEntered)) throw e;
    throw new FiledNotEntered(e.why, {
      cause: e,
      again: 'The proposal is written down and raised. Make this change again from this page: this device finds the proposal it '
        + 'wrote down and enters it, and nothing is raised twice.',
    });
  }
}

/** What writing a governance proposal down needs of this device: its seat, the key epoch a bare key seals at, and fresh names. */
interface GovernanceFilingDoors {
  /** This device's seat on the company, as its directory entry names it. */
  readonly seat: string;
  readonly keyEpoch: number;
  readonly salt: () => string;
  readonly newId: () => string;
  /** The one filing call, bound to this company and this seat: a proposal written down here is entered in the company's records. */
  readonly entered: RecordsEntered;
}

/**
 * The doors a governance change is taken through: the governed-call doors, what
 * writing a proposal down needs, and the company as this device counts it for
 * the vault check (`approverRosterFrom`), with each vault's name to say it by.
 */
export type GovernanceDoors = GovernedCallDoors & {
  readonly filing: GovernanceFilingDoors;
  readonly approvers: () => Promise<ApproverRoster>;
  readonly vaultName: (vault: Hex) => string;
  /**
   * Anchors every filing of the company not yet anchored, from this device
   * (`anchorTheRecordsHere`); absent, a change that waits for the anchor is
   * refused until another device has anchored.
   */
  readonly anchorDirectory?: () => Promise<unknown>;
};

/**
 * **A RISE OF THE ACCOUNT'S THRESHOLD WAITS FOR EVERY DIRECTORY CHANGE FILED
 * TO BE ANCHORED.** A change not yet anchored is counted against who holds the
 * account when it is anchored, so a rise that lands first has it counted at
 * the higher threshold, where it could be lost for good. This device anchors them
 * first, where it can, and refuses while any is still not anchored, saying
 * what resolves it. A vault raised past the account's threshold waits the same
 * way, since carrying it out raises the seat bar with it. A lowered or unchanged
 * threshold waits for nothing.
 */
async function riseWaitsForTheDirectory(doors: GovernanceDoors, threshold: number): Promise<void> {
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot raise the threshold. Reload the page to '
      + 'get the current version.');
  }
  let here = await doors.records.directory();
  if (threshold <= here.holders.approvals) return;
  if (directoryNotYetAnchored(here).length > 0 && doors.anchorDirectory !== undefined) {
    await doors.anchorDirectory();
    here = await doors.records.directory();
  }
  const left = directoryNotYetAnchored(here);
  if (left.length > 0) {
    throw new Error(`The approval threshold is not raised while ${left.length > 1 ? 'versions' : 'version'} ${left.join(', ')} of the `
      + `company's directory ${left.length > 1 ? 'are' : 'is'} filed and not yet anchored: raised first, a change not yet anchored `
      + 'would be counted at the higher threshold and could be lost. Nothing was sent. Open the company on the device of a seat '
      + 'that may anchor, which anchors them at once, then raise the threshold again.');
  }
}

/**
 * Refuses a spending policy whose highest band asks for more signers than may
 * approve its vault's runs, counted with the bands in force on that vault as this
 * device opens them (`policyChangeRefusal`). Refuses, with nothing sent, when it
 * was not told the bands in force or the policy's own highest band, since the
 * vault would then be counted as asking for none.
 */
async function refuseAPolicyLeavingAVaultShort(
  doors: GovernanceDoors, vault: string, highestBand: number | undefined, bandsInForce: (() => Promise<readonly BandInForce[]>) | undefined,
): Promise<void> {
  if (highestBand === undefined || bandsInForce === undefined) {
    throw new NotOpenedOnThisDevice('This device was not told the bands of the spending policies in force, so it cannot count who '
      + 'approves the vault\'s runs at its bands. Nothing was sent. Reload the page to get the current version.');
  }
  const no = policyChangeRefusal(await doors.approvers(), await bandsInForce(), { vault, band: highestBand }, doors.vaultName);
  if (no !== null) throw new Error(`${no.charAt(0).toUpperCase()}${no.slice(1)} Nothing was sent.`);
}

/**
 * A governance change, as the vault check counts it. A seat added that sets a
 * threshold is counted with the rights its invitation's role gives on the
 * vaults it names (`invitedSeatRightsOf`) and the threshold it sets. A removal is counted with the threshold
 * it leaves the company at, where it names one. A spending policy is counted at
 * its bands by `refuseAPolicyLeavingAVaultShort`, from what it opens to; the
 * approvals a policy change needs are no run's bar, so a change of them leaves
 * every vault as it was and is not counted.
 */
const changeCounted = (change: GovernedThroughTheRecords, seatRights?: SeatRights): VaultCheckChange | null => {
  if (change.kind === 'add-signer') {
    /* A seat added that keeps the threshold never leaves a vault short of approvers, and the leaf it adds is the invitee's to make. */
    const t = thresholdCounted(change.threshold, true);
    if (t === 0) return null;
    if (seatRights === undefined) {
      throw new NotOpenedOnThisDevice('This device was not told which rights the invited seat carries, so it cannot count who approves each '
        + 'vault\'s runs once this seat is taken. Nothing was sent. Reload the page to get the current version.');
    }
    return { kind: 'seatAndThreshold', rights: seatRights, threshold: t };
  }
  if (change.kind === 'remove-signer') {
    const t = thresholdCounted(change.threshold, true);
    return t === 0 ? { kind: 'remove', leaf: change.leaf.toLowerCase() as Hex } : { kind: 'removeAndThreshold', leaf: change.leaf.toLowerCase() as Hex, threshold: t };
  }
  if (change.kind === 'threshold') return { kind: 'threshold', threshold: thresholdCounted(change.threshold) };
  if (change.kind === 'spending-policy' || change.kind === 'policy-bar') return null;
  return { kind: 'vaultThreshold', vault: change.vault.toLowerCase() as Hex, threshold: thresholdCounted(change.threshold) };
};

/**
 * **A SEAT ADDED WITH A NEW THRESHOLD IS CHECKED AS THE CHAIN WILL CHECK IT, AND FOR EVERY VAULT**
 * (`seatThresholdRefusal`): no higher than the seats the person's own wallet reads on the chain now and the one the
 * invitation adds, and leaving no vault short of signers who may approve its runs, the new seat counted on the vaults
 * its rights reach. A rise then waits for every directory change filed to be anchored, as any rise of the threshold does.
 */
async function refuseASeatThresholdHere(doors: GovernanceDoors, change: SeatThresholdChange): Promise<void> {
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot seat a signer with a new threshold. '
      + 'Reload the page to get the current version.');
  }
  const seats = (await doors.records.directory()).holders.seats.length;
  const no = seatThresholdRefusal(await doors.approvers(), { seats }, change, doors.vaultName);
  if (no !== null) throw new Error(`${refusalSaid(no)} Nothing was sent.`);
  await riseWaitsForTheDirectory(doors, change.threshold);
}

/**
 * How far a threshold change is taken from this device: `before` is the check the
 * caller makes before every send, after the device's own; `approveOnly`,
 * `stopBeforeCarry` and `carryOnly` are `governOnDevice`'s.
 */
export interface ThresholdChangeSteps {
  readonly before?: () => Promise<void>;
  readonly approveOnly?: string;
  readonly stopBeforeCarry?: boolean;
  readonly carryOnly?: boolean;
}

const stepsOf = (o: ThresholdChangeSteps) => ({
  ...(o.approveOnly === undefined ? {} : { approveOnly: o.approveOnly }),
  ...(o.stopBeforeCarry === undefined ? {} : { stopBeforeCarry: o.stopBeforeCarry }),
  ...(o.carryOnly === undefined ? {} : { carryOnly: o.carryOnly }),
});

/** Changes the account's threshold, as far as this device can: see `governOnDevice`. */
export function changeThresholdOnDevice(
  doors: GovernanceDoors, input: { viewingKey: KeysHeld; newThreshold: number; seated: number } & ThresholdChangeSteps,
): Promise<GovernedOutcome> {
  if (!Number.isInteger(input.newThreshold) || input.newThreshold < 1) {
    return Promise.reject(new Error('the threshold must be a whole number, at least one. Nothing was sent.'));
  }
  return governOnDevice(doors, {
    viewingKey: input.viewingKey,
    change: { kind: 'threshold', threshold: String(input.newThreshold) },
    summary: `Change the approval threshold to ${input.newThreshold} of ${input.seated}`,
    body: { newThreshold: input.newThreshold },
    before: async () => { await riseWaitsForTheDirectory(doors, input.newThreshold); await input.before?.(); },
    ...stepsOf(input),
  });
}

/**
 * **ONE VAULT'S OWN APPROVALS NEEDED, CHANGED AS FAR AS THIS DEVICE CAN.** The
 * proposal names the vault and the number; it is carried out at the bar
 * `setVaultThreshold` asks for (`thresholdCarryBar`). A rise past the account's
 * threshold waits for the directory to be anchored, and `before` is the check
 * every signer's device makes before every send.
 */
export function changeVaultThresholdOnDevice(
  doors: GovernanceDoors,
  input: { viewingKey: KeysHeld; vault: string; newThreshold: number; seated: number } & ThresholdChangeSteps,
): Promise<GovernedOutcome> {
  if (!Number.isInteger(input.newThreshold) || input.newThreshold < 1) {
    return Promise.reject(new Error('a vault\'s approvals needed must be a whole number, at least one. Nothing was sent.'));
  }
  if (!HEX64.test(input.vault)) return Promise.reject(new Error('that is not a vault\'s address. Nothing was sent.'));
  if (input.newThreshold > input.seated) {
    return Promise.reject(new Error(`a vault cannot need more approvals than the ${input.seated} signers the company has seated, `
      + 'or nothing from it could ever be approved. Seat more signers first, or choose a smaller number. Nothing was sent.'));
  }
  return governOnDevice(doors, {
    viewingKey: input.viewingKey,
    change: { kind: 'vault-threshold', vault: input.vault, threshold: String(input.newThreshold) },
    summary: `Set this vault's approval threshold to ${input.newThreshold} of ${input.seated}`,
    body: { vault: input.vault as Hex, newThreshold: input.newThreshold },
    before: async () => { await riseWaitsForTheDirectory(doors, input.newThreshold); await input.before?.(); },
    ...stepsOf(input),
  });
}

export { governOnDevice };

/** An inviter record as a proposal carries it: the wallet key, the signed entry and the opening, and nothing else. */
const inviterRecordOf = (x: Inviter): Inviter => ({ committeeKey: { tag: x.committeeKey.tag, value: x.committeeKey.value }, statement: x.statement, opening: x.opening });

/** A device asked only to approve found no proposal raised on the chain to approve: nothing was sent. */
export class NothingToApprove extends Error {
  readonly nothingWasSent = true;
  constructor() {
    super('The company holds no proposal raised on the chain for this change that this device was asked to approve, so nothing '
      + 'was approved. Nothing was sent. Reload the page: it may have been withdrawn, or not raised yet.');
    this.name = 'NothingToApprove';
  }
}

/**
 * A device asked only to approve found nothing left for this seat to approve, and sent nothing: `counted`, the chain
 * already counts this seat's approval (a raise counts its raiser's); `carried-out`, the chain closed the proposal by
 * carrying it out, so for a seat offered by address the invitee has taken the seat and Finish adding is what is owed.
 */
export class ApprovalNotOwed extends Error {
  readonly nothingWasSent = true;
  constructor(readonly why: 'counted' | 'carried-out') {
    super(why === 'counted'
      ? 'The network already counts your approval of this proposal, so nothing was approved again. Nothing was sent.'
      : 'The network has already carried this proposal out, so there is nothing left to approve. Nothing was sent.');
    this.name = 'ApprovalNotOwed';
  }
}

/** The address and rights an invitation raises are not the ones a seat that may invite signed. Nothing was raised. */
export class InvitationNotBound extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'InvitationNotBound';
  }
}

/**
 * An invitation by address as its raise needs it: the signed invitation, the salt its proposal is raised under, and
 * the coin key of the address typed. A device that raises the proposal must give the coin key, which the proposal
 * carries sealed; a device that approves a proposal already raised gives the one the proposal carries, checked again
 * against the commitment, or none.
 */
export interface SeatInvitationToRaise {
  readonly invited: SignedSeatInvitation;
  /** The salt the proposal's identity was made with: the one the invitation makes (`invitationProposalSalt`), and the invitee's wallet carries. */
  readonly proposalSalt: string;
  readonly name: string;
  readonly inviter?: Inviter;
  readonly coinPublicKey?: Hex;
}

/** The builder's working-out of a proposal's identity on this page; refused, with nothing sent, on a page that has none. */
export const proposalIdentityOn = (builder: GovernanceDoors['builder']) => (change: GovernanceOnTheWire, salt: string): Promise<ProposalIdentity> => {
  if (builder.proposalIdentity === undefined) {
    throw new Error('This page cannot work out a proposal\'s identity. Reload the page to get the current version. Nothing was sent.');
  }
  return builder.proposalIdentity(change, salt);
};

/**
 * **A SEAT OFFERED BY ADDRESS, RAISED BEFORE ANYBODY HAS ACCEPTED IT, AND APPROVED.** The invitation names the
 * commitment to the address that was typed, the rights the seat carries, the threshold it sets once taken (where it
 * names one) and the proposal raised for it; this device checks it was signed by a seated signer who may invite, that
 * the salt is the one the invitation itself makes, and that the proposal it raises or approves is exactly the one its
 * change and that salt make (the one raise step, `raiseTheSeatHere`), so it commits to the whole invitation. A threshold it sets is checked before
 * every send as the chain will check it, and against every vault (`refuseASeatThresholdHere`), with the seat counted on
 * the vaults its role's rights reach (`invitedSeatRightsOf`). Nothing waits for an acceptance and no fingerprint is read: the invitee's own wallet takes the
 * seat (`seatInvited`), proving it holds the address, once the approvals reach the seat bar, and this device never
 * carries it out. Called again from another seat's device, it approves the same proposal; asked only to approve
 * (`approveOnly`, the proposal's identity on the chain), it raises nothing.
 */
export async function raiseSeatInvitationOnDevice(
  doors: GovernanceDoors & { readonly roster: RosterDoors }, input: { readonly viewingKey: KeysHeld } & SeatInvitationToRaise,
  inviteAddressOf?: InviteAddressOf, o: { readonly approveOnly?: string } = {},
): Promise<GovernedOutcome> {
  const t = input.invited.terms;
  if (t.invite === undefined || t.proposal === undefined || t.leaf !== undefined) {
    throw new InvitationNotBound('This invitation is not one made by address, naming the proposal raised for it, so nothing was raised.');
  }
  const invite = t.invite;
  const coin = input.coinPublicKey?.toLowerCase() as Hex | undefined;
  if (coin !== undefined) {
    if (inviteAddressOf === undefined) {
      throw new InvitationNotBound('This device cannot check the address this invitation commits to, so nothing was raised. Reload the page.');
    }
    if (String(inviteAddressOf(coin, invite.salt.toLowerCase() as Hex)).toLowerCase() !== invite.address.toLowerCase()) {
      throw new InvitationNotBound('The coin key given is not the one the invitation\'s address commits to, so nothing was raised. '
        + 'Invite the person again.');
    }
  }
  return raiseTheSeatHere(doors, {
    viewingKey: input.viewingKey, invited: input.invited, salt: input.proposalSalt, name: input.name, byItsProposal: true,
    ...(input.inviter === undefined ? {} : { inviter: input.inviter }), ...(o.approveOnly === undefined ? {} : { approveOnly: o.approveOnly }),
    body: coin === undefined ? {} : { coinPublicKey: coin },
    /* Only a raise reaches this with no round opened: a proposal raised without the coin key hides a wallet invited twice. */
    before: async (opened) => {
      if (opened === undefined && coin === undefined) {
        throw new InvitationNotBound('This invitation is raised without the coin key of the address it invites, so nothing was raised. '
          + 'Invite the person again from the device that typed the address.');
      }
    },
  });
}

/**
 * **THE ONE RAISE STEP FOR A SIGNER INVITATION**, by address or by a link or a
 * code. The invitation must be signed by a seat this device believes may
 * invite, offering only vaults within its own, and name the address the
 * proposal invites (`invitationByAddressRefusal`); the proposal is the one its
 * change (`seatByAddressChangeOf`) and the salt its own signed terms make
 * (`approvedInvitationRefusal`), filed under that salt so the approvers'
 * signatures commit to the whole invitation, and the new seat is counted on
 * the vaults its role's rights reach (`invitedSeatRightsOf`). `byItsProposal`
 * finds an open round by the proposal the invitation names; otherwise by its
 * change, as a second device's own signature makes another proposal. `body`
 * adds what the way in carries beside the invitation.
 */
export async function raiseTheSeatHere(
  doors: GovernanceDoors & { readonly roster: RosterDoors },
  input: {
    readonly viewingKey: KeysHeld; readonly invited: SignedSeatInvitation; readonly salt: string; readonly name: string; readonly inviter?: Inviter;
    readonly byItsProposal: boolean; readonly approveOnly?: string; readonly body: Readonly<Record<string, unknown>>;
    readonly before: (opened?: OpenedRound) => Promise<void>;
  },
): Promise<GovernedOutcome> {
  const t = input.invited.terms;
  if (t.invite === undefined) throw new InvitationNotBound(`${NOT_APPROVED_SAID['not-raised']}, so nothing was raised. Invite the person again.`);
  const seats = seatingOf(await rosterHere(doors.roster), doors.roster.reads).seats;
  const refused = invitationByAddressRefusal(doors.roster.accountId, input.invited, t.invite, seats);
  if (refused !== null) throw new InvitationNotBound(refused);
  const change = seatByAddressChangeOf(t.invite);
  const identity = await proposalIdentityOn(doors.builder)(change, input.salt);
  const unbound = approvedInvitationRefusal(input.invited, { salt: input.salt, chainId: identity.chainId });
  if (unbound !== null) throw new InvitationNotBound(`${NOT_APPROVED_SAID[unbound]}, so nothing was raised. Invite the person again.`);
  return governOnDevice({ ...doors, filing: { ...doors.filing, salt: () => input.salt }, leaves: doors.roster.reads.leaves }, {
    viewingKey: input.viewingKey,
    change,
    ...(input.byItsProposal ? { proposal: t.proposal! } : {}),
    summary: change.threshold === undefined ? `Add ${input.name} as a signer` : `Add ${input.name} as a signer, then need ${change.threshold} approvals`,
    body: {
      ...input.body, invite: { address: change.address, scope: change.scope }, invited: input.invited,
      ...(input.inviter === undefined ? {} : { inviter: inviterRecordOf(input.inviter) }),
    },
    before: input.before,
    ...(input.approveOnly === undefined ? {} : { approveOnly: input.approveOnly }),
    seatRights: invitedSeatRightsOf(t, change.scope),
  });
}

/** What the person approving a seat by address was shown before they approved: the proposal, and what it invites. */
export interface SeatInvitationShown {
  /** The proposal's name in the company's records. */
  readonly proposal: string;
  readonly name: string;
  /** The role the seat is invited with, as the proposal's signed invitation names it: what the new seat may do. */
  readonly role: Role;
  /** The commitment to the address invited, as the proposal's invitation names it. */
  readonly address: string;
  readonly scope: string;
  readonly coinPublicKey: string;
  /** The approvals the account needs once the seat is taken, as digits; none or "0" keeps the threshold in force. */
  readonly threshold?: string;
}

/**
 * **A SEAT OFFERED BY ADDRESS, APPROVED FROM ANOTHER SEAT'S DEVICE, EXACTLY AS IT WAS SHOWN.** The proposal is opened
 * here from the company's records (`addSignerByAddressIn`) and approved only when it invites the very name, role,
 * commitment, rights, threshold once seated and coin key shown, the coin key makes that commitment under the invitation's salt, and the wallet behind it
 * holds no seat here and no other open invitation, on the chain or written down with a raise that may still land by the
 * chain's time (`addressSeatedOrInvitedRefusal`, with the coin keys the roster this device believes records), and no other proposal this device believes under the same id on the network carries
 * another invitation (`believedSeatingsUnder`, which believes only a record whose invitation makes that id, so a second
 * invitation filed under it is passed over), which the admission would refuse after the seat is taken. It is then approved as every seat offered by address is
 * (`raiseSeatInvitationOnDevice`), which raises nothing: unless the chain already holds that proposal raised, nothing
 * is sent. A proposal the chain has already carried out is refused as owed nothing (`ApprovalNotOwed`), and so is
 * an approval the chain already counts for this seat. Every refusal comes before anything is built or sent.
 */
export async function approveSeatInvitationOnDevice(
  doors: GovernanceDoors & { readonly roster: RosterDoors },
  input: { readonly viewingKey: KeysHeld; readonly shown: SeatInvitationShown; readonly chainTime?: () => Promise<number> },
  inviteAddressOf: InviteAddressOf,
): Promise<GovernedOutcome> {
  const low = (x: unknown): string => String(x).toLowerCase();
  const { shown } = input;
  if (!doors.service.sealedProposals) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s proposals, so it cannot approve this one. Reload the page '
      + 'to get the current version. Nothing was sent.');
  }
  const rec = (await doors.service.sealedProposals(doors.accountId) as readonly SealedProposal[]).find((p) => p.id === shown.proposal);
  const body = rec === undefined ? null : addSignerByAddressIn(rec, doors.accountId, input.viewingKey);
  if (body === null) {
    throw new InvitationNotBound((rec === undefined ? null : addSignerInvitationRefusalIn(rec, doors.accountId, input.viewingKey)) ?? 'The company holds no proposal to add a seat by address under that name that this device can open, '
      + 'so nothing was approved. Nothing was sent. Reload the page.');
  }
  const invite = body.invited.terms.invite!;
  if (body.invited.terms.name !== shown.name || low(invite.address) !== low(shown.address) || low(invite.scope) !== low(shown.scope)
    || body.coinPublicKey === null || body.coinPublicKey !== low(shown.coinPublicKey)) {
    throw new InvitationNotBound('The proposal the company holds under that name invites another person, address or rights than the '
      + 'ones shown, so nothing was approved. Nothing was sent. Do not approve it: reload the page and check it again.');
  }
  /* The threshold the seat sets once taken is the signed invitation's, and must be the one shown: none and "0" both keep the one in force. */
  if ((invite.threshold ?? '0') !== (shown.threshold === undefined || shown.threshold === '' ? '0' : shown.threshold)) {
    throw new InvitationNotBound(`The proposal the company holds under that name sets the approvals needed to ${invite.threshold ?? 'what they are now'} `
      + `once the seat is taken, not to ${shown.threshold === undefined || shown.threshold === '' || shown.threshold === '0' ? 'what they are now' : shown.threshold} `
      + 'as shown, so nothing was approved. Nothing was sent. Do not approve it: reload the page and check it again.');
  }
  if (body.invited.terms.role !== shown.role) {
    throw new InvitationNotBound(`The proposal the company holds under that name invites this person as ${body.invited.terms.role}, `
      + `not as ${String(shown.role)} as shown, so nothing was approved. Nothing was sent. Do not approve it: reload the page and check it again.`);
  }
  if (low(inviteAddressOf(body.coinPublicKey, low(invite.salt) as Hex)) !== low(invite.address)) {
    throw new InvitationNotBound('The coin key this proposal carries is not the one its invitation\'s address commits to, so nothing '
      + 'was approved. Nothing was sent. Do not approve it.');
  }
  /* Where the proposal stands is read from the chain, never the service's status: closed by being carried out, it owes no approval. */
  if (doors.records?.roundsOnChain !== undefined) {
    const [standing] = await standingOnChainHere(doors.records, [{ id: rec!.id, chainId: body.chainId, status: rec!.status }]);
    if (standing?.status === 'executed') throw new ApprovalNotOwed('carried-out');
  }
  const held = await addressSeatedOrInvitedRefusal(addressReadsOf(doors, input.chainTime), doors.accountId, input.viewingKey,
    inviteAddressOf, body.coinPublicKey, body.chainId);
  if (held !== null) throw new InvitationNotBound(`This proposal was not approved, and nothing was sent: ${held}.`);
  const seats = seatingOf(await rosterHere(doors.roster), doors.roster.reads).seats;
  const beside = await believedSeatingsUnder(await doors.records!.directory(kindAsked('proposal')), await doors.records!.proposals!(),
    doors.accountId, input.viewingKey, body.chainId, seats, proposalIdentityOn(doors.builder));
  if (beside.some((x) => !sameInvitation(x.invited, body.invited))) {
    throw new InvitationNotBound('Another proposal the company holds under the same id on the network carries another invitation, '
      + 'filed and signed by a seat that may invite, so the person could take the seat and never be admitted. Nothing was approved. '
      + 'Nothing was sent. Do not approve it: ask the seats that raised them to withdraw both, and invite the person again.');
  }
  return raiseSeatInvitationOnDevice(doors, {
    viewingKey: input.viewingKey, invited: body.invited, proposalSalt: body.proposalSalt, name: body.invited.terms.name,
    coinPublicKey: body.coinPublicKey, ...(body.inviter === undefined ? {} : { inviter: body.inviter }),
  }, inviteAddressOf, { approveOnly: body.chainId });
}

/**
 * The doors `inviteHere` raises a seat offered by address through, from this seat's governance doors: where this
 * device keeps the invitation before it is raised (`keep`), whether the address's wallet is already seated or invited
 * here (`addressSeatedOrInvitedRefusal`, from the company's proposals and this device's own read of the chain and its
 * time, `chainTime`), the
 * proposal's identity as this device's builder makes it, and the raise itself (`raiseSeatInvitationOnDevice`), which
 * checks the coin key against the commitment before the proposal carries it.
 */
export const signerByAddressDoorsOf = (
  doors: GovernanceDoors & { readonly roster: RosterDoors }, viewingKey: KeysHeld,
  network: SignerByAddressDoors['network'], commitments: SignerByAddressDoors['commitments'], keep: SignerByAddressDoors['keep'],
  chainTime?: () => Promise<number>,
): SignerByAddressDoors => ({
  keep,
  network,
  commitments,
  held: (coinPublicKey, except) => addressSeatedOrInvitedRefusal(addressReadsOf(doors, chainTime), doors.accountId, viewingKey,
    (c, salt) => commitments.inviteAddressOf(c, salt), coinPublicKey, except),
  identity: async (change, salt) => proposalIdentityOn(doors.builder)(change, salt),
  raise: (input) => raiseSeatInvitationOnDevice(doors, { viewingKey, ...input }, (c, salt) => commitments.inviteAddressOf(c, salt)),
});

/* ── A SIGNER REMOVED, FROM THIS DEVICE ──────────────────────────────────────── */

/** What a removal asks of this device beyond any governance change. */
export type RemovalDoors = GovernanceDoors & {
  /**
   * The leaving seat's records-key statement as the roster this device believes holds it, exactly as its own wallet
   * signed it (`leaversStatementIn`); null where no statement counts for the seat.
   */
  readonly leaversStatement: (seat: DirectorySeat) => Promise<RecordsKeyStatement | null>;
  /**
   * Files a quorum's change to the company's directory for the version its signatures name, and anchors it at once
   * (`directoryChangeFiledHere`). Absent, no removal is carried out or finished from this device.
   */
  readonly directoryChange?: (change: SignedChange, signedFor: number) => Promise<unknown>;
  /** Where this device keeps a retirement once it has read a quorum's signatures for it, to file it again. */
  readonly kept?: DirectoryChangesKeptStore;
  /**
   * Where this device keeps every retirement signature it made or read for a removal, by proposal: its own the moment
   * it signs, and each it believed among those the service served. A carrier counts them beside the service's.
   */
  readonly signatures?: RetirementSignaturesKept;
  /**
   * What changing the company's key needs once a removal is carried out on the chain and its retirement anchored: the
   * key the wallet released, the copy the service serves this seat, the waiting answers, the seats the roster admitted,
   * and the filing of the change (`rotateTheCompanyKeyHere`). Absent, this device changes no key.
   */
  readonly companyKey?: Pick<RotationDoors, 'filings' | 'served' | 'released' | 'askTheWallet' | 'waiting' | 'admitted' | 'file' | 'revoked'>;
};

/** The retirement signatures one device keeps for each removal it signed or read. */
export interface RetirementSignaturesKept {
  keep(company: string, proposalId: string, signatures: readonly RetirementSignature[]): Promise<void>;
  all(company: string, proposalId: string): Promise<readonly RetirementSignature[]>;
}

/**
 * The invitation to a seat is open on the chain and can never seat anyone: a signer was removed or replaced since it was
 * raised, so the account refuses the seat it offers (`requireApproved`). Nothing was approved or sent.
 */
export class InvitationOutrun extends Error {
  readonly nothingWasSent = true;
  constructor() {
    super('a signer was removed or replaced since this invitation was raised, so it can no longer seat anyone. Nothing was '
      + 'approved or sent. Withdraw it, and invite the person again.');
    this.name = 'InvitationOutrun';
  }
}

/**
 * The removal is open on the chain and can never be carried out there: a signer was removed or replaced since it was
 * raised, so the account refuses it (`requireApproved`). Nothing was filed or sent.
 */
export class RemovalRaisedAgain extends Error {
  constructor() {
    super('a signer was removed or replaced since this removal was raised, so the chain will never carry it out. Nothing was filed '
      + 'or sent. Withdraw it from the device of the signer who raised it, then raise the removal again: a retirement already '
      + 'anchored for this seat stays, and is not signed again.');
    this.name = 'RemovalRaisedAgain';
  }
}

/**
 * Where a removal stands after this device has done what it can, and, once it is done, what changing the company's key
 * came to. A change of the key that fails leaves the removal done.
 */
export type RemovalOutcome = (
  | GovernedOutcome
  /** Approved on the chain, or carried out there, and its retirement not yet signed by enough seats to be filed. */
  | { readonly state: 'waiting-for-the-retirement'; readonly round: RoundOnThePage | null; readonly signed: number; readonly needed: number }
) & { readonly rotation?: KeyRotated };

/**
 * **A REMOVAL DONE, AND THE COMPANY'S KEY CHANGED AFTER IT FROM THIS DEVICE** where this page can
 * (`rotateTheCompanyKeyHere`): never from the leaving seat's device, nor one under an approved removal. Whatever the change
 * of the key comes to, even a throw, the removal stays done.
 */
const rotatedAfter = async (doors: RemovalDoors, viewingKey: KeysHeld, leaf: string, outcome: RemovalOutcome): Promise<RemovalOutcome> => {
  if (outcome.state !== 'done' || doors.companyKey === undefined || doors.records === undefined) return outcome;
  let rotation: KeyRotated;
  try {
    rotation = await rotateTheCompanyKeyHere({
      ...doors.companyKey, accountId: doors.accountId, material: doors.material, records: doors.records,
      leaving: () => seatsLeavingHere(doors, viewingKey, true),
    }, { leaf });
  } catch (e) {
    rotation = { state: 'not-rotated', why: (e as Error)?.message ?? String(e) };
  }
  return { ...outcome, rotation };
};

/** A removal's retirement is not yet signed by enough seats for the directory version next now. Nothing was sent to the chain. */
export class RetirementNotYetSigned extends Error {
  constructor(readonly signed: number, readonly needed: number) {
    super(`the retirement of the leaving seat is signed by ${signed} of the ${needed} seats it needs for the company's directory as it `
      + 'stands now, so the removal is not carried out on the chain yet. Nothing was sent. Each signer who approved it opens the '
      + 'removal again on their own device, which signs the retirement again.');
    this.name = 'RetirementNotYetSigned';
  }
}

/** Every record a seat may have filed, asked of the company's records, with every entry not yet anchored. */
const EVERY_RECORD_ASKED: RecordsAsked = Object.freeze({
  kinds: [
    ...COMPANY_RECORD_KINDS.map((kind) => ({ store: 'company' as const, kind })),
    ...WIRE_RECORDS.map((kind) => ({ store: 'vault' as const, kind })),
    { store: 'run' as const, kind: 'run' }, { store: 'proposal' as const, kind: 'proposal' },
  ],
  everyPending: true,
});

/**
 * **THE LAST VERSION OF EACH RECORD `filer` FILED**, of every kind, as the
 * anchor holds the company's records for this read: the boundary a retirement
 * keeps, past which nothing that seat filed is believed. A version entered and
 * not yet anchored is not counted: it is anchored first (`leaversPendingIn`).
 * Given `atSeq`, the batch the anchored head a removal's raise names left,
 * only the versions anchored at or before it are counted: the boundary signed
 * at the raise is final: what the seat files after it counts toward no
 * approval, is not anchored by a device told of the raise
 * (`AnchorDoors.leaving`), and is believed by no device once the retirement
 * is anchored.
 */
export const lastVersionsFiledBy = (here: DirectoryHere, filer: string, atSeq?: number): Record<string, number> => {
  const key = filer.toLowerCase();
  const out: Record<string, number> = {};
  const counted = (store: string, kind: string, id: string, version: number): void => {
    if (store === 'directory') return;
    const at = boundaryKeyOfEntry({ store, kind, id, version, digest: '' } as unknown as ManifestEntryBody);
    out[at] = Math.max(out[at] ?? 0, version);
  };
  for (const [recordKey, versions] of here.records.history) {
    const [store, kind] = recordKey.split(':', 2) as [string, string];
    const id = recordKey.slice(store.length + kind.length + 2);
    for (const v of versions) if (v.filedBy.toLowerCase() === key && (atSeq === undefined || v.batch <= atSeq)) counted(store, kind, id, v.version);
  }
  return out;
};

/** How many versions `filer` entered that the anchor does not hold yet, as this read sees them. */
const leaversPendingIn = (here: DirectoryHere, filer: string): number =>
  here.records.notYetAnchored.filter((e) => e.store !== 'directory' && e.filedBy.publicKey.toLowerCase() === filer.toLowerCase()).length;

/** Whether two boundaries name the same records at the same versions, no more and no fewer. */
const sameBoundary = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

/** A removal's retirement as the directory holds it, signatures aside. */
const retirementOf = (leaf: string, terms: RetirementTerms) => ({
  kind: 'retire' as const, seat: leaf, filedUpTo: { ...terms.filedUpTo },
  ...(terms.statement === undefined ? {} : { statement: { ...terms.statement } }), threshold: terms.threshold,
});

/** The text every seat signs for a removal's retirement at directory version `version`. */
const retirementMessage = (company: string, version: number, leaf: string, terms: RetirementTerms): string =>
  directoryChangeMessage(company, version, { ...retirementOf(leaf, terms), signatures: [] } as SignedChange);

const sameStatement = (a: RetirementTerms['statement'], b: RetirementTerms['statement']): boolean =>
  a === undefined ? b === undefined
    : b !== undefined && a.recordsKey.toLowerCase() === b.recordsKey.toLowerCase() && a.seat.toLowerCase() === b.seat.toLowerCase()
      && a.signature.toLowerCase() === b.signature.toLowerCase();

/**
 * The retirement terms this device would raise for `seat` now: its last versions as the anchored head this read reached
 * holds them, that head, its statement where one counts, the seat bar.
 */
const retirementTermsHere = async (doors: RemovalDoors, here: DirectoryHere, seat: DirectorySeat): Promise<RetirementTerms> => {
  const statement = await doors.leaversStatement(seat);
  return {
    filedUpTo: lastVersionsFiledBy(here, seat.signingKey), atHead: here.records.reached.head, threshold: here.holders.seatBar,
    ...(statement === null ? {} : { statement: { recordsKey: statement.recordsKey, seat: statement.seat, signature: statement.signature } }),
  };
};

/**
 * **WHY THIS DEVICE WILL NOT RAISE, APPROVE OR CARRY OUT THIS REMOVAL, OR NULL.**
 * Read from the company's records and the chain as the person's own wallet
 * reads them now, never from the service:
 * - a removal of another seat is in flight - its retirement in the directory,
 *   its seat still on the chain - so two removals never leave the company
 *   short of the approvals a change of who is seated needs;
 * - a seat the directory holds an entry for is removed only with its
 *   retirement, and a leaf it holds none for only without one;
 * - the retirement is signed at least at the seat bar now;
 * - where this device's roster holds the leaving seat's own statement, the
 *   retirement carries exactly that statement, so the records it filed stay
 *   readable to the signers who stay;
 * - the retirement keeps every spending policy version the leaving seat filed
 *   (`removalBoundaryRefusal`).
 * Before a raise (`raised` false) the boundary is judged over everything the
 * leaving seat filed, and a version of theirs not yet anchored holds the raise
 * until it is. At an approval or the carrying out it is judged over what was
 * anchored at the head the raise names (`RetirementTerms.atHead`), which this
 * device must have checked itself: the boundary signed at the raise is final,
 * and what the leaving seat anchors after that head - before the raise lands
 * or after - voids nothing. That head must also be recent at the raise
 * (`anchoredHeadHere`, against `raise`, the proposal as the chain holds it).
 */
const removalRefusalHere = async (
  doors: RemovalDoors, here: DirectoryHere, leaf: string, terms: RetirementTerms | undefined, raised = false, raise?: RaiseRead,
): Promise<string | null> => {
  const inFlight = here.dir.seats.find((x) => x.seat !== leaf && x.retired !== null && here.holders.seats.includes(x.seat));
  if (inFlight !== undefined) {
    return 'another signer\'s removal is under way: their seat is retired in the company\'s directory and the chain still holds it. '
      + 'Finish that removal first, then this one';
  }
  const seat = here.dir.seats.find((x) => x.seat === leaf);
  if (seat === undefined) {
    return terms === undefined ? null : 'this removal carries a retirement for a seat the company\'s directory holds no entry for';
  }
  if (seat.retired !== null) return null;
  if (terms === undefined) return 'this removal carries no retirement for a seat the company\'s directory holds an entry for';
  if (terms.threshold < here.holders.seatBar) {
    return `its retirement is signed at ${terms.threshold} approvals, below the ${here.holders.seatBar} a change of who is seated needs now`;
  }
  const statement = await doors.leaversStatement(seat);
  if (statement !== null && !sameStatement(terms.statement, statement)) {
    return 'its retirement leaves out, or changes, the records-key statement the leaving signer\'s own wallet signed, so what they '
      + 'filed could not be read once they leave';
  }
  if (!raised && leaversPendingIn(here, seat.signingKey) > 0) {
    return 'the leaving signer has filed versions the company\'s records do not anchor yet, and a retirement is judged only over '
      + 'what is anchored. Open the company on the device of a seat that may anchor, which anchors them, then try again';
  }
  const atSeq = raised ? anchoredHeadHere(here, terms, raise) : undefined;
  if (typeof atSeq === 'string') return atSeq;
  if (!sameBoundary(terms.filedUpTo, lastVersionsFiledBy(here, seat.signingKey, atSeq))) {
    return 'its retirement does not keep exactly the last version of each record the leaving signer filed, as the anchored records '
      + 'held them at the head the removal was raised over: a boundary below one would leave it unread, and one above would let '
      + 'them file after they leave. Withdraw this removal and raise it again';
  }
  return removalBoundaryRefusal(here, seat.signingKey, terms.filedUpTo, atSeq === undefined ? undefined : (batch) => batch <= atSeq);
};

/**
 * **HOW OLD THE HEAD A REMOVAL'S RAISE NAMES MAY BE, IN BLOCK TIME, IN
 * MILLISECONDS.** A raise naming a head older than the newest that landed at
 * least this long before the raise's own block is refused, so a raiser cannot
 * pick an old head whose boundary leaves out what the leaving seat filed since.
 */
export const RECENT_HEAD_WINDOW = 10 * 60 * 1000;

/** The proposal a removal's raise made, as the account's history at the wallet's indexer holds it; `no-history` where this page reads none. */
type RaiseRead = RoundOnChain | 'no-history' | undefined;

/** Why how recent a raise's head is cannot be judged here, each saying what resolves it. */
const RECENT_HEAD_UNJUDGED = {
  raiseNotRead: 'its raise was not read from the indexer your wallet names, so how recent the head it names is cannot be judged. '
    + 'Read the chain again in a moment, then try again',
  noHistory: 'this page cannot read the account\'s history at the indexer your wallet names, so how recent the head its raise '
    + 'names is cannot be judged. Reload the page to get the current version, then try again',
  checkedShort: 'this device has not checked the company\'s records as far as the newest head that landed ten minutes or more '
    + 'before its raise, so how recent the head it names is cannot be judged here. Open the company again on this device so it '
    + 'checks its records further, or approve from a device that has',
} as const;

/**
 * The batch the anchored head a removal's raise names (`RetirementTerms.atHead`) left, as this device checked the
 * company's records itself; or why it cannot be judged, in words that say what resolves it. The head must not be older
 * than the newest head that landed `RECENT_HEAD_WINDOW` or more before the block the raise landed in. Both times are
 * the blocks' own, read from the history of the account at the wallet's indexer, never from the service: the raise's
 * from `raise` (`roundsOnChain`), the heads' from `newestLandedBy`. A raise not read there, a page that reads no
 * history, and a reference head this device did not check each refuse with what resolves them (`RECENT_HEAD_UNJUDGED`);
 * a raise the indexer gave no block time for is raised again.
 */
const anchoredHeadHere = (here: DirectoryHere, terms: RetirementTerms, raise: RaiseRead): number | string => {
  if (terms.atHead === undefined) {
    return 'its retirement does not name the anchored head its boundary was taken at, so what the leaving signer had filed by then '
      + 'cannot be said. Withdraw this removal and raise it again';
  }
  const seq = here.records.seqOfHead?.(terms.atHead) ?? null;
  if (seq === null) {
    return 'its retirement names an anchored head this device has not checked in the company\'s records, so its boundary cannot be '
      + 'judged here. Check the company\'s records on this device from its first header, or approve from a device that has; '
      + 'a head the company\'s records never held is refused on every device';
  }
  if (raise === 'no-history') return RECENT_HEAD_UNJUDGED.noHistory;
  const at = raise?.raisedAt;
  if (at === undefined) return RECENT_HEAD_UNJUDGED.raiseNotRead;
  if (!Number.isSafeInteger(at) || at <= 0) {
    return 'the indexer your wallet names gave no time for the block its raise landed in, so how recent the head it names is '
      + 'cannot be judged. The signer who raised it withdraws it and raises this removal again';
  }
  const newest = here.records.newestLandedBy?.(at - RECENT_HEAD_WINDOW) ?? 'unread';
  if (newest === 'unread') return RECENT_HEAD_UNJUDGED.checkedShort;
  if (newest !== 'none' && seq < newest.seq) {
    return `its retirement names an anchored head older than one the company's records held ${RECENT_HEAD_WINDOW / 60_000} minutes `
      + 'or more before the raise landed, so its boundary could leave out what the leaving signer filed since. The signer who '
      + 'raised it withdraws it and raises this removal again';
  }
  return seq;
};

/** This seat's signature over the retirement at the directory version next now, or none where this seat does not sign. */
const retirementSignedHere = (doors: RemovalDoors, here: DirectoryHere, leaf: string, terms: RetirementTerms): RetirementSignature | undefined => {
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  if (!here.dir.seats.some((x) => x.signingKey === mine && x.retired === null)) return undefined;
  const signedFor = here.dir.version + 1;
  return { signedFor, publicKey: mine, signature: sign(retirementMessage(doors.accountId, signedFor, leaf, terms), doors.material.signingSecret as Hex) };
};

/** The removal's proposal as the service keeps it: the retirement signatures each approving seat sent beside it. */
const signaturesServed = async (doors: RemovalDoors, proposalId: string): Promise<readonly RetirementSignature[]> => {
  const served = (await doors.service.sealedProposals?.(doors.accountId)) ?? [];
  return served.find((p) => p.id === proposalId && p.accountId === doors.accountId)?.retirementSignatures ?? [];
};

/**
 * **THE SIGNATURES OVER A RETIREMENT THIS DEVICE BELIEVES**, for directory
 * version `signedFor`: each by a seat the directory holds and has not retired,
 * or by the leaving seat itself, verifying over exactly these terms; one per
 * seat. The service only keeps them, so each is checked here.
 */
const signaturesBelieved = (
  doors: RemovalDoors, here: DirectoryHere, leaf: string, terms: RetirementTerms, signedFor: number, given: readonly RetirementSignature[],
): { publicKey: Hex; signature: Hex }[] => {
  const message = retirementMessage(doors.accountId, signedFor, leaf, terms);
  const out = new Map<string, { publicKey: Hex; signature: Hex }>();
  for (const g of given) {
    const key = String(g?.publicKey ?? '').toLowerCase();
    if (g?.signedFor !== signedFor || out.has(key) || !/^[0-9a-f]{128}$/u.test(String(g.signature))) continue;
    if (!here.dir.seats.some((x) => x.signingKey === key && (x.retired === null || x.seat === leaf))) continue;
    if (!verify(message, g.signature, key as Hex)) continue;
    out.set(key, { publicKey: key as Hex, signature: g.signature });
  }
  return [...out.values()];
};

/**
 * **THE RETIREMENT FILED AND ANCHORED, OR REFUSED, BEFORE ANYTHING ELSE.**
 * The signatures this device believes for the directory version next now are
 * gathered from those the service keeps beside the proposal, and this seat
 * signs again where its own is missing; once they reach the quorum, the full
 * retirement is kept on this device and filed and anchored at once. Refused,
 * with nothing sent to the chain, while too few have signed, or while the
 * filed retirement is not anchored.
 */
const retirementFiledHere = async (
  doors: RemovalDoors, proposalId: string | null, leaf: string, terms: RetirementTerms, others: readonly RetirementSignature[] = [],
): Promise<void> => {
  if (doors.directoryChange === undefined) {
    throw new Error('This page cannot file a retirement in the company\'s directory, so it carries out no removal. Reload the page to get '
      + 'the current version. Anything this press already sent may have gone through and stands; nothing more is sent.');
  }
  const records = doors.records!;
  const here = await records.directory(EVERY_RECORD_ASKED);
  const signedFor = here.dir.version + 1;
  const kept = ((await doors.kept?.all(doors.accountId)) ?? []).filter((k) => k.signedAt === signedFor && k.change.kind === 'retire'
    && k.change.seat === leaf);
  const served = proposalId === null ? [] : await signaturesServed(doors, proposalId);
  let given = [...others, ...served, ...(proposalId === null ? [] : await signaturesKeptHere(doors, proposalId)),
    ...kept.flatMap((k) => k.change.signatures.map((x) => ({ signedFor, publicKey: x.publicKey, signature: x.signature })))];
  const mine = retirementSignedHere(doors, here, leaf, terms);
  if (mine !== undefined && !signaturesBelieved(doors, here, leaf, terms, signedFor, given).some((x) => x.publicKey === mine.publicKey)) {
    if (proposalId !== null) await doors.service.retire?.(proposalId, { signature: mine, filer: filerHere(doors) });
    given = [...given, mine];
  }
  const believed = signaturesBelieved(doors, here, leaf, terms, signedFor, given);
  if (proposalId !== null) await keepSignaturesHere(doors, proposalId, believed.map((x) => ({ signedFor, ...x })));
  const needed = Math.max(terms.threshold, here.holders.seatBar);
  if (believed.length < needed) throw new RetirementNotYetSigned(believed.length, needed);
  const change = { ...retirementOf(leaf, terms), signatures: believed } as SignedChange;
  await doors.kept?.keep(doors.accountId, { signedAt: signedFor, change });
  await doors.directoryChange(change, signedFor);
  const after = await records.directory();
  const left = directoryNotYetAnchored(after);
  if (!after.dir.seats.some((x) => x.seat === leaf && x.retired !== null) || left.length > 0) {
    throw new Error('the retirement of the leaving seat is filed and not yet anchored, so the removal is not carried out on the chain. '
      + 'Your signature of the retirement, and the retirement, may have gone through and stand; nothing more is sent. Open the company again '
      + 'on a device whose seat may anchor, then carry out the removal again.');
  }
};

/** The retirement signatures this device kept for a removal, none where it keeps none. */
const signaturesKeptHere = async (doors: RemovalDoors, proposalId: string): Promise<readonly RetirementSignature[]> =>
  (await doors.signatures?.all(doors.accountId, proposalId)) ?? [];

/** Keeps `signatures` on this device beside those it kept for the same removal. */
const keepSignaturesHere = async (doors: RemovalDoors, proposalId: string, signatures: readonly RetirementSignature[]): Promise<void> => {
  if (signatures.length > 0) await doors.signatures?.keep(doors.accountId, proposalId, signatures);
};

/**
 * For a raised removal this device has judged: this seat signs the retirement again at the directory version next now
 * only where the service serves a signature of this seat's that checks over these very terms at the version it named,
 * so an entry the service lists under this seat's key and this seat never made triggers nothing. Then the signatures
 * this device believes, served and kept, are kept here, and once they reach the quorum the retirement is kept whole,
 * so this device can file it whatever the service later serves.
 */
const retirementGatheredHere = async (
  doors: RemovalDoors, here: DirectoryHere, leaf: string, proposalId: string, terms: RetirementTerms,
): Promise<void> => {
  const mine = retirementSignedHere(doors, here, leaf, terms);
  const served = await signaturesServed(doors, proposalId);
  const signedBefore = mine !== undefined && served.some((x) => x.signedFor !== mine.signedFor && Number.isSafeInteger(x.signedFor)
    && signaturesBelieved(doors, here, leaf, terms, x.signedFor, [x]).some((b) => b.publicKey === mine.publicKey));
  if (doors.service.retire !== undefined && mine !== undefined && signedBefore && !served.some((x) => x.publicKey === mine.publicKey
    && x.signedFor === mine.signedFor)) {
    await doors.service.retire(proposalId, { signature: mine, filer: filerHere(doors) });
  }
  const signedFor = here.dir.version + 1;
  const believed = signaturesBelieved(doors, here, leaf, terms, signedFor,
    [...await signaturesServed(doors, proposalId), ...await signaturesKeptHere(doors, proposalId)]);
  await keepSignaturesHere(doors, proposalId, believed.map((x) => ({ signedFor, ...x })));
  if (believed.length >= Math.max(terms.threshold, here.holders.seatBar)) {
    await doors.kept?.keep(doors.accountId, { signedAt: signedFor, change: { ...retirementOf(leaf, terms), signatures: believed } as SignedChange });
  }
};

/**
 * Refuses, with nothing filed or sent, a removal the chain will never carry out (`RemovalRaisedAgain`), as its history
 * reads now; else the proposal as that history holds it (nothing where it holds none), or `no-history` where this page
 * reads no history.
 */
const refuseAnOutrunRemoval = async (doors: RemovalDoors, chainId: string): Promise<RaiseRead> => {
  if (doors.records!.roundsOnChain === undefined) return 'no-history';
  const read = (await doors.records!.roundsOnChain([chainId.toLowerCase()]))?.[chainId.toLowerCase()];
  if (read?.outrun === true) throw new RemovalRaisedAgain();
  return read;
};

/**
 * **WHY A CHANGE THAT RAISES THE BAR ON CHANGING WHO IS SEATED WAITS FOR A
 * REMOVAL UNDER WAY, OR NULL**: a seat retired in the directory that the chain
 * still holds, or a removal the chain holds approved (`removalsApprovedHere`).
 * Raised now, the bar would take back the approvals that removal already has,
 * and could rise past the signers who stay, so it could never be carried out.
 * A removal raised and not yet approved holds no rise up: one that rises under
 * it is refused at its next approval and raised again (`removalRefusalHere`).
 */
const removalUnderWayHere = async (doors: GovernanceDoors, viewingKey: KeysHeld, own?: string): Promise<string | null> => {
  const here = await doors.records!.directory();
  if (here.dir.seats.some((x) => x.retired !== null && x.seat !== own && here.holders.seats.includes(x.seat))) {
    return 'a signer\'s seat is retired in the company\'s directory and the chain still holds it';
  }
  return (await removalsApprovedHere(doors, viewingKey)).some((r) => r.leaf !== own) ? 'a removal of a signer is approved and not yet carried out' : null;
};

/**
 * **NO BAR ON CHANGING WHO IS SEATED RISES WHILE A REMOVAL IS UNDER WAY.** A
 * new account threshold, approvals for policy changes or vault threshold above
 * the seat bar the person's own wallet reads now raises that bar, and so does a
 * spending policy whose highest band is above it, since the account raises the
 * bar to a policy's highest band when the policy is carried out (`setPolicy`).
 * Each is refused, saying what resolves it, until the removal is carried out
 * or withdrawn. A spending policy whose highest band this device was not given
 * is refused the same way while a removal is under way, never taken as no rise.
 * A removal that sets a new threshold above that bar is held to the same rule,
 * counting every removal under way but its own: its own seat retired and its own
 * approval are what carrying it out needs. A signer added with a new threshold
 * above that bar is held to the same rule. Every other change (a signer added
 * keeping the threshold, a removal keeping the threshold, a vault adopted, a new
 * pay key) raises no bar and waits for nothing here.
 */
async function refuseABarRaisedDuringARemoval(
  doors: GovernanceDoors, viewingKey: KeysHeld, change: GovernedThroughTheRecords, highestBand?: number,
): Promise<void> {
  const asked = change.kind === 'threshold' || change.kind === 'vault-threshold' ? Number(change.threshold)
    : change.kind === 'policy-bar' ? Number(change.bar)
      : change.kind === 'spending-policy' ? highestBand ?? Number.POSITIVE_INFINITY
        : (change.kind === 'remove-signer' || change.kind === 'add-signer') && Number(change.threshold ?? '0') > 0 ? Number(change.threshold) : null;
  if (asked === null || doors.records === undefined) return;
  if (asked <= (await doors.records.directory()).holders.seatBar) return;
  const why = await removalUnderWayHere(doors, viewingKey, change.kind === 'remove-signer' ? change.leaf.toLowerCase() : undefined);
  if (why !== null) {
    throw new Error(`This change would raise the approvals a change of who is seated needs while ${why}, which could leave that `
      + 'removal unable ever to be carried out. Nothing was sent. Carry out or withdraw the removal first, then make this change.');
  }
}

/** Every directory version filed and not yet anchored, anchored from here where this device may; refused while one still waits. */
const directoryAnchoredFirst = async (doors: RemovalDoors): Promise<void> => {
  let here = await doors.records!.directory();
  if (directoryNotYetAnchored(here).length > 0 && doors.anchorDirectory !== undefined) {
    await doors.anchorDirectory();
    here = await doors.records!.directory();
  }
  const left = directoryNotYetAnchored(here);
  if (left.length > 0) {
    throw new Error(`A signer is not removed while ${left.length > 1 ? 'versions' : 'version'} ${left.join(', ')} of the company's `
      + 'directory are filed and not yet anchored: the retirement is filed after them and anchored at once, before the chain is '
      + 'asked. Anything this press already sent may have gone through and stands; nothing more is sent. Open the '
      + 'company on the device of a seat that may anchor, then carry out the removal again.');
  }
};

/**
 * What reading who is leaving needs: the service's proposals, the company's records and who the chain seats. Only the
 * records' directory and the chain's standing of each proposal are read.
 */
export type LeavingReads = Pick<GovernedCallDoors, 'service' | 'accountId' | 'leaves'> & { readonly records?: RecordsForTheRound };

/** Why who is leaving could not be read in full, so nothing that must exclude them goes ahead. */
export class LeavingNotRead extends Error {
  /** Set when a proposal that does not open holds the read up, so reading again does not clear it. */
  readonly blocking: boolean;
  constructor(why: string, blocking = false) {
    super(`who is under a removal could not be read in full: ${why}`);
    this.name = 'LeavingNotRead';
    this.blocking = blocking;
  }
}

/**
 * The company's open removals, or with `open` false every removal and where it stands on the chain, each opened on
 * this device from its records: the leaf each takes off. With `strict`,
 * a proposal this device cannot open, or records, proposals or the chain's standing it cannot read, refuse with
 * `LeavingNotRead` instead of being passed over, so an answer that leaves a removal out is never given; one refused
 * after its sealed record named another kind than a removal is no removal, and is passed over either way. Each is
 * opened only far enough to read its kind unless it is a removal, so a run that fails its own checks holds up nothing.
 */
export const removalsOpenHere = async (
  doors: LeavingReads, viewingKey: KeysHeld, open = true, strict = false,
): Promise<{ id: string; leaf: string; opened: OpenedRound; status: string }[]> => {
  if (doors.records === undefined || !doors.service.sealedProposals) {
    if (strict) throw new LeavingNotRead('this page reads no proposals or records of the company');
    return [];
  }
  if (strict && doors.records.roundsOnChain === undefined) throw new LeavingNotRead('this page cannot read where the company\'s proposals stand on the chain');
  const served = await doors.service.sealedProposals(doors.accountId);
  const named = await doors.records.directory(kindAsked('proposal'));
  const listed = await standingOnChainHere(doors.records, listedHere(named, 'proposal', served, 'proposal'));
  const out: { id: string; leaf: string; opened: OpenedRound; status: string }[] = [];
  for (const p of listed) {
    if (p.accountId !== doors.accountId || (open && p.status !== 'open')) continue;
    try {
      const opened = await openTheRoundHere(doors.service, doors.accountId, p.id, viewingKey, false, doors.records, doors.leaves, false, 'remove-signer');
      if (opened.governance?.kind === 'remove-signer') out.push({ id: p.id, leaf: opened.governance.leaf.toLowerCase(), opened, status: p.status });
    } catch (e) {
      /*
       * One this device cannot open names no removal it acts on, unless every removal must be known; one its sealed
       * record names another kind than a removal is none, however it was refused after; so is one whose only refusal
       * is that the seat that filed it has left the company and filed it past what its retirement kept, since no
       * device acts on it and the chain no longer seats its filer.
       */
      if (passedOverAs(e, 'remove-signer')) continue;
      if (strict) throw new LeavingNotRead(blockingProposalSaid(named, p.id, e), true);
    }
  }
  return out;
};

type RemovalOnChain = { id: string; leaf: string; opened: OpenedRound; round: RoundOnChain };

/**
 * **THE COMPANY'S REMOVALS THE CHAIN HOLDS AS RAISED**, of those open on this
 * device (`removalsOpenHere`), each with where it stands as read from the
 * account's history at the person's own wallet's indexer: one filed with the
 * service and never raised on the chain sets no boundary and holds no change
 * up. None where this device cannot read the chain's standing; with `strict`,
 * that refuses with `LeavingNotRead` (`removalsOpenHere`).
 */
const removalsRaisedHere = async (doors: LeavingReads, viewingKey: KeysHeld, strict = false): Promise<RemovalOnChain[]> => {
  const open = await removalsOpenHere(doors, viewingKey, true, strict);
  if (open.length === 0) return [];
  const read = await doors.records?.roundsOnChain?.(open.map((r) => r.opened.chainId.toLowerCase()));
  return open.flatMap((r) => {
    const round = read?.[r.opened.chainId.toLowerCase()];
    return round !== undefined && (round.held === 'open' || round.held === 'cleared') && round.raisedAt !== undefined ? [{ ...r, round }] : [];
  });
};

/**
 * **THE COMPANY'S REMOVALS THE CHAIN HOLDS AS APPROVED**: raised
 * (`removalsRaisedHere`), raised since the chain's last removal (not
 * `outrun`), and approved as many times as the account demands to carry it
 * out - the higher of the approvals a change of who is seated needs now, as
 * the person's own wallet reads the chain (`holders.seatBar`), and the
 * approvals the chain recorded the removal as needing when it was raised
 * (`RoundOnChain.needed`). The count is the chain's, over every seat, the
 * leaving one's included. From here a seat is leaving: before it, a removal
 * raised stops nothing. Approved does not mean the carrying out will pass:
 * the account also keeps enough signers seated, and a refused carrying out is
 * read again. A seat bar this device could not read counts every raised
 * removal as approved, never as one leaving nobody; with `strict`, it refuses
 * with `LeavingNotRead`.
 */
const removalsApprovedHere = async (doors: LeavingReads, viewingKey: KeysHeld, strict = false): Promise<RemovalOnChain[]> => {
  const raised = await removalsRaisedHere(doors, viewingKey, strict);
  if (raised.length === 0) return raised;
  const bar = (await doors.records!.directory()).holders?.seatBar;
  if (!Number.isSafeInteger(bar) || (bar as number) < 1) {
    if (strict) throw new LeavingNotRead('your wallet\'s read of the company\'s account did not say how many approvals a change of who is seated needs');
    return raised;
  }
  return raised.filter((r) => r.round.outrun !== true && r.round.approvals >= Math.max(bar as number, r.round.needed ?? 0));
};

/**
 * **THE SEATS AN APPROVED REMOVAL IS ABOUT, BY FILING KEY, EACH WITH THE
 * BOUNDARY THE RAISE SIGNED** - the retirement terms its proposal carries,
 * final from the raise; none where it carries none - and any seat retired
 * whose removal the chain has not carried out yet, with the boundary its
 * retirement keeps, as this device reads the company's records and the chain
 * now. What no device anchors or believes a version past
 * (`AnchorDoors.leaving`): what the leaving seat filed after the raise and
 * before the approval is anchored and believed until then, and passed over
 * once the removal is approved. With `raised`, the seats a removal is only
 * raised for are named too, but not those of an outrun removal
 * (`seatsUnderARaisedRemovalHere`). It reads the
 * company's records through `doors.records`, which must not be given this
 * answer back, or each read would ask for itself. With `strict`, anything it
 * cannot read refuses with `LeavingNotRead` rather than leave a seat out.
 */
export async function leavingBoundariesHere(
  doors: LeavingReads, viewingKey: KeysHeld, strict = false, raised = false,
): Promise<LeavingBoundaries> {
  const out = new Map<string, Readonly<Record<string, number>>>();
  if (doors.records === undefined) {
    if (strict) throw new LeavingNotRead('this page cannot read the company\'s records');
    return out;
  }
  const here = await doors.records.directory();
  const named = raised ? (await removalsRaisedHere(doors, viewingKey, strict)).filter((r) => r.round.outrun !== true)
    : await removalsApprovedHere(doors, viewingKey, strict);
  for (const r of named) {
    const seat = here.dir.seats.find((x) => x.seat === r.leaf);
    if (seat !== undefined) out.set(seat.signingKey.toLowerCase(), r.opened.retirement?.filedUpTo ?? {});
  }
  for (const x of here.dir.seats) {
    if (x.retired !== null && here.holders.seats.includes(x.seat)) out.set(x.signingKey.toLowerCase(), x.retired);
  }
  return out;
}

/**
 * **THE FILING KEYS OF THE SEATS AN APPROVED REMOVAL IS ABOUT**, and of any
 * seat retired whose removal the chain has not carried out yet
 * (`leavingBoundariesHere`): what a leaving seat's own device stops filing
 * under, and what changes the company's key without that seat. With `strict`,
 * as `leavingBoundariesHere`.
 */
export async function seatsLeavingHere(doors: LeavingReads, viewingKey: KeysHeld, strict = false): Promise<ReadonlySet<string>> {
  return new Set((await leavingBoundariesHere(doors, viewingKey, strict)).keys());
}

/**
 * **THE FILING KEYS OF THE SEATS A REMOVAL IS RAISED FOR**, approved or not
 * and not outrun (the account will never carry an outrun one out), and of any
 * seat retired that the chain still holds: whose spending policy a
 * policy change is not approved or carried out under, and whose proposals and
 * runs filed after the raise a staying device does not approve or carry out
 * (`refuseWhatALeaverFiledHere`, from `leavingBoundariesHere` with `raised`),
 * so nothing the chain acts on rests on a record that is passed over once the
 * removal is approved. With `strict`, as `leavingBoundariesHere`.
 */
export async function seatsUnderARaisedRemovalHere(doors: LeavingReads, viewingKey: KeysHeld, strict = false): Promise<ReadonlySet<string>> {
  return new Set((await leavingBoundariesHere(doors, viewingKey, strict, true)).keys());
}

/**
 * **A PROPOSAL OR RUN A SEAT FILED AFTER ITS OWN REMOVAL WAS RAISED IS NOT
 * APPROVED OR CARRIED OUT FROM A STAYING DEVICE.** Its record is past the
 * boundary that removal's raise signed (`pastTheRaisedBoundary`): anchored and
 * believed while the removal waits for its approvals, and passed over once it
 * is approved, so nothing the chain does may rest on it. One the seat filed
 * before its removal was raised is within that boundary, and goes ahead as
 * any other; so does everything once the removal is outrun, since the account
 * will never carry that removal out. The filer is the seat whose signed filing
 * this device believed when it opened the proposal (`OpenedRound.filedBy`),
 * never a second read of the service. Each refusal says what resolves it, and
 * nothing is sent:
 *   - no believed record names who raised it;
 *   - who is under a raised removal could not be read in full (`LeavingNotRead`);
 *   - its record is past the boundary its filer's raised removal signed.
 * The one exception is a removal of a signer (`exemptFromWhoFiled`); a run is never exempt.
 */
const refuseWhatALeaverFiledHere = async (
  doors: LeavingReads, viewingKey: KeysHeld, proposalId: string, opened: OpenedRound,
): Promise<void> => {
  const filer = typeof opened.filedBy === 'string' ? opened.filedBy.toLowerCase() : null;
  if (filer === null) {
    throw new Error('This device holds no signed filing of this proposal in the company\'s records, so who raised it cannot be '
      + 'said, and a proposal raised by a signer on their way out is not approved or carried out. Nothing was sent. Reload the '
      + 'page and open it again; if it happens again, whoever raised it raises it again from their own device.');
  }
  if (exemptFromWhoFiled(opened)) return;
  let boundaries: LeavingBoundaries;
  try {
    boundaries = await leavingBoundariesHere(doors, viewingKey, true, true);
  } catch (e) {
    if (!(e instanceof LeavingNotRead)) throw e;
    throw new Error(`This is not approved or carried out while ${e.message}. Nothing was sent.${e.blocking ? '' : ' Read the chain again, then try again.'}`);
  }
  if (!pastTheRaisedBoundary(boundaries, filer, boundaryKeyOfEntry({ store: 'proposal', kind: 'proposal', id: proposalId, version: 1, digest: '' } as ManifestEntryBody), 1)) return;
  throw new Error('This was raised by a signer whose removal is raised, after it was raised, and what they file now is passed over '
    + 'once their removal is approved. Nothing was sent. Do not approve or carry it out; once the removal is carried out, a '
    + 'signer who stays raises it again, or once it is withdrawn, approve it then.');
};

/**
 * Whether a proposal goes ahead whoever filed it: every removal of a signer, so a seat that raises the removal of every
 * other signer first can still be removed by one of them. Every other proposal, and every run, is judged by when its
 * filer filed it (`refuseWhatALeaverFiledHere`).
 */
const exemptFromWhoFiled = (opened: OpenedRound): boolean => opened.governance?.kind === 'remove-signer';

/**
 * **A RUN ITS SEAT RAISED AFTER ITS OWN REMOVAL WAS RAISED IS NOT CHARGED OR
 * PAID FROM A STAYING DEVICE** (`refuseWhatALeaverFiledHere`), however its
 * approvals were given: carrying a run out is charging it to its period
 * (`chargeTheRunHere`) and paying each person (`payAnApprovedLeg`), and each
 * asks this first, before anything is built or sent. Who raised it is read
 * from the run's proposal as the company's records believe it
 * (`proposalsListedHere`, `believedFilerHere`). A page given no proposals,
 * a run the records do not list, or one whose filing this device does not
 * believe is refused, saying what resolves it.
 */
export async function refuseARunALeaverRaisedHere(
  records: RecordsForTheRound, accountId: string, viewingKey: KeysHeld, proposalId: string,
): Promise<void> {
  const proposals = records.proposals;
  if (proposals === undefined) {
    throw new Error('This page cannot read the company\'s proposals, so it cannot say who raised this run, and a run raised by a '
      + 'signer on their way out is not charged or paid. Nothing was sent. Reload the page to get the current version.');
  }
  const listed = await proposalsListedHere({ ...records, proposals });
  const rec = listed.find((p) => p.id === proposalId && p.accountId === accountId);
  if (rec === undefined) {
    refusedForItsKey(listed, proposalId, 'proposal');
    throw new Error('The company\'s records hold no proposal by that name, so who raised this run cannot be said, and it is not '
      + 'charged or paid. Nothing was sent. Reload the page to see where it stands.');
  }
  const filedBy = await believedFilerHere(records, accountId, rec);
  /* Only the company's proposals are read through this service: which removals are raised. */
  const service = { sealedProposals: async () => proposals() } as unknown as GovernedCallService;
  const opened = { filedBy: filedBy ?? undefined } as OpenedRound;
  await refuseWhatALeaverFiledHere({ service, accountId, records }, viewingKey, proposalId, opened);
}

/**
 * Why this device's own seat files nothing more, or null: a removal of its seat is approved, so what it would file now
 * falls past the boundary the retirement keeps, and a signer who stays files it again under their own seat. While the
 * removal is only raised, this seat files as before.
 */
export async function ownRemovalApprovedHere(doors: GovernanceDoors, viewingKey: KeysHeld): Promise<string | null> {
  const mine = signingPublicKeyOf(doors.material.signingSecret as Hex);
  return (await seatsLeavingHere(doors, viewingKey)).has(mine)
    ? 'a removal of this signer\'s seat is approved, so this device files nothing more for the company: a signer who stays files it instead'
    : null;
}

/**
 * **A REMOVAL THE CHAIN HAS ALREADY CARRIED OUT, FINISHED FROM THIS DEVICE**:
 * the leaf is off the chain, so what is left is its retirement in the
 * directory, filed with the signatures this device keeps or the service keeps
 * beside the removal's proposal - never signed by anyone again where a quorum
 * already signed it. A leaf the directory holds no entry for, or a seat
 * already retired, leaves nothing to file. Once done, the company's key is
 * changed from here (`rotatedAfter`).
 */
const removalFinishedHere = async (doors: RemovalDoors, viewingKey: KeysHeld, leaf: string, here: DirectoryHere): Promise<RemovalOutcome> =>
  rotatedAfter(doors, viewingKey, leaf, await retirementFinishedHere(doors, viewingKey, leaf, here));

/** What finishing a removal the chain carried out leaves to file: the retirement, from this device; `NoRetirementToFile` when it holds none. */
async function retirementFinishedHere(doors: RemovalDoors, viewingKey: KeysHeld, leaf: string, here: DirectoryHere): Promise<RemovalOutcome> {
  const seat = here.dir.seats.find((x) => x.seat === leaf);
  if (seat === undefined || seat.retired !== null) return { state: 'done', round: null };
  const kept = ((await doors.kept?.all(doors.accountId)) ?? []).find((k) => k.change.kind === 'retire' && k.change.seat === leaf
    && k.signedAt === here.dir.version + 1);
  if (kept !== undefined && doors.directoryChange !== undefined) {
    await doors.directoryChange(kept.change, kept.signedAt);
    return { state: 'done', round: null };
  }
  const raised = (await removalsOpenHere(doors, viewingKey, false)).filter((r) => r.leaf === leaf && r.opened.retirement !== undefined);
  let short: RetirementNotYetSigned | null = null;
  for (const r of raised) {
    try {
      await retirementFiledHere(doors, r.id, leaf, r.opened.retirement!);
      return { state: 'done', round: null };
    } catch (e) {
      if (!(e instanceof RetirementNotYetSigned)) throw e;
      short ??= e;
    }
  }
  if (short !== null) return { state: 'waiting-for-the-retirement', round: null, signed: short.signed, needed: short.needed };
  throw Object.assign(new Error('The chain no longer holds this signer, and this device finds no retirement of their seat to file. Nothing '
    + 'was sent. Open the company on the device of a signer who approved the removal, which keeps its retirement and files it.'), { name: 'NoRetirementToFile' });
}

/**
 * **A SIGNER REMOVED, AS FAR AS THIS DEVICE CAN TAKE IT.** One ordinary
 * proposal at the approvals a change of who is seated needs (`requireSeatBar`),
 * the leaving seat's own approval counted like any other. Raised with the
 * retirement of its seat built here; approving it also signs that retirement,
 * one press per signer. Carried out in this order: every directory version
 * waiting is anchored; the retirement is filed and anchored at once; only then
 * is the chain asked to take the leaf off, by `removeSignerAndSetThreshold`
 * with the threshold the removal was raised with (`newThreshold`; none or 0
 * keeps the one in force, and a rise waits for the directory to be anchored,
 * as any threshold rise does). `before` runs after every other check, before
 * every send; the steps say whether this call raises, only approves or only
 * carries out (`ThresholdChangeSteps`). Whether the removal has been carried
 * out already is read from the chain, never from the service's words: a
 * removal the chain carried out first is finished here by filing its
 * retirement. Once the removal is done, the company's key is changed from
 * here where these doors can (`rotatedAfter`). `summary`, where given, is the
 * name the removal is filed under. The wallet's removal action is its caller. A removal waits while a seat whose invitation raises the
 * threshold above the bar the removal is approved at is open
 * (`seatRaisingTheBarHere`).
 */
export async function removeSignerOnDevice(
  doors: RemovalDoors, input: { viewingKey: KeysHeld; leaf: string; name: string; newThreshold?: number; summary?: string } & ThresholdChangeSteps,
): Promise<RemovalOutcome> {
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot remove a signer. Reload the page to get '
      + 'the current version.');
  }
  const leaf = input.leaf.toLowerCase();
  if (!HEX64.test(leaf)) throw new Error('that is not a signer\'s seat. Nothing was sent.');
  const newThreshold = input.newThreshold ?? 0;
  if (!Number.isSafeInteger(newThreshold) || newThreshold < 0) {
    throw new Error('the approvals needed once the signer is removed must be a whole number; 0 keeps the number in force. Nothing was sent.');
  }
  const records = doors.records;
  let here = await records.directory(EVERY_RECORD_ASKED);
  if (!here.holders.seats.includes(leaf)) return removalFinishedHere(doors, input.viewingKey, leaf, here);
  let seat = here.dir.seats.find((x) => x.seat === leaf);
  /* The removal asked, at the threshold asked: another open removal of the same seat is another proposal. */
  const asked = { kind: 'remove-signer' as const, leaf, ...(newThreshold === 0 ? {} : { threshold: String(newThreshold) }) };
  const live = (await removalsOpenHere(doors, input.viewingKey))
    .find((r) => r.leaf === leaf && r.opened.governance !== undefined && sameGovernance(r.opened.governance as GovernanceOnTheWire, asked));
  /*
   * Before a raise, what the leaving seat entered and the anchor does not hold yet is anchored first, so the boundary is
   * judged over it. Once raised, what that seat files is past the boundary the raise signed, and is not anchored for it.
   */
  if (live === undefined && seat !== undefined && seat.retired === null && leaversPendingIn(here, seat.signingKey) > 0
    && doors.anchorDirectory !== undefined) {
    await doors.anchorDirectory();
    here = await records.directory(EVERY_RECORD_ASKED);
    seat = here.dir.seats.find((x) => x.seat === leaf);
  }
  const made = seat === undefined || seat.retired !== null ? undefined : await retirementTermsHere(doors, here, seat);
  /*
   * Before a raise nothing has been sent. Once it is raised, the raise and anything this device sent before the check
   * stand, and a refusal sends nothing more for the removal from here.
   */
  const refuse = async (terms: RetirementTerms | undefined, raised = false, raise?: RaiseRead): Promise<void> => {
    const now = await records.directory(EVERY_RECORD_ASKED);
    const bound = raised ? null : removalThresholdRefusal(now.holders, leaf as Hex, newThreshold) ?? noAdminLeftRefusal(now.dir.seats, [...(await doors.approvers()).seats.keys()], leaf);
    const why = bound?.replace(/\.$/u, '') ?? await removalRefusalHere(doors, now, leaf, terms, raised, raise);
    if (why === null) return;
    throw new Error(raised
      ? `This removal is raised, and this device does not approve it or carry it out: ${why}. Nothing more is sent for it from here.`
      : `This removal is not raised from this device: ${why}. Nothing was sent.`);
  };
  try {
    /*
     * A removal raised on the chain is judged as its approval is - outrun, its terms, the head it names - before this
     * seat signs its retirement again or keeps a quorum's signatures: a removal this device refuses gets neither, and
     * one the wallet's indexer does not show raised gets neither until it does.
     */
    if (live?.opened.retirement !== undefined) {
      const raise = await refuseAnOutrunRemoval(doors, live.opened.chainId);
      if (raise !== 'no-history' && raise?.raisedAt !== undefined) {
        await refuse(live.opened.retirement, true, raise);
        await retirementGatheredHere(doors, here, leaf, live.id, live.opened.retirement);
      }
    }
    return await rotatedAfter(doors, input.viewingKey, leaf, await governOnDevice(doors, {
      viewingKey: input.viewingKey,
      change: asked,
      summary: input.summary ?? (newThreshold === 0 ? `Remove ${input.name} as a signer` : `Remove ${input.name} as a signer, and need ${newThreshold} approvals`),
      body: { leaf: leaf as Hex, ...(newThreshold === 0 ? {} : { newThreshold }), ...(made === undefined ? {} : { retirement: made }) },
      /*
       * Before a raise, the terms about to be raised; at an approval or the carrying out, the proposal's own, judged
       * against what was anchored at the head the raise names, and that head against the block the raise landed in.
       */
      before: async (opened) => {
        const seat = await seatRaisingTheBarHere(doors, input.viewingKey);
        if (seat !== null) throw new Error(seat);
        if (opened === undefined) await refuse(made);
        else await refuse(opened.retirement, true, await refuseAnOutrunRemoval(doors, opened.chainId));
        if (newThreshold > 0) await riseWaitsForTheDirectory(doors, newThreshold);
        await input.before?.();
      },
      /* This seat's own signature is kept here the moment it is made, whatever the service later serves. */
      signs: async (opened, round) => {
        if (opened.retirement === undefined) return undefined;
        const mine = retirementSignedHere(doors, await records.directory(), leaf, opened.retirement);
        if (mine !== undefined) await keepSignaturesHere(doors, round.id, [mine]);
        return mine;
      },
      beforeCarry: async (opened, round) => {
        await refuseAnOutrunRemoval(doors, opened.chainId);
        await directoryAnchoredFirst(doors);
        const now = await records.directory();
        const held = now.dir.seats.find((x) => x.seat === leaf);
        if (opened.retirement !== undefined && held !== undefined && held.retired === null) {
          await retirementFiledHere(doors, round.id, leaf, opened.retirement);
        }
      },
      carry: (opened) => ({
        circuit: 'removeSignerAndSetThreshold', leaf, threshold: String(newThreshold), proposal: opened.chainId, proposalSalt: opened.salt, removing: true,
      }),
      ...stepsOf(input),
    }));
  } catch (e) {
    if (!(e instanceof RetirementNotYetSigned)) {
      /* A carrying out that failed may have lost to another device's: whether the leaf is off is read from the chain again. */
      const now = await records.directory(EVERY_RECORD_ASKED);
      if (!now.holders.seats.includes(leaf)) return removalFinishedHere(doors, input.viewingKey, leaf, now);
      throw e;
    }
    return { state: 'waiting-for-the-retirement', round: live === undefined ? null : { id: live.id, chainId: live.opened.chainId, status: 'open' },
      signed: e.signed, needed: e.needed };
  }
}

/**
 * A door's fields with the company's keys added under the name the shared code reads them by. The keys are the
 * company's, opened by a seat, never a wallet's own key; the wallet builds every door that carries them through this,
 * so no wallet source names the field.
 */
export const withCompanyKeys = <T extends object>(door: T, keys: KeysHeld): T & { readonly viewingKey: KeysHeld } => ({ ...door, viewingKey: keys });

/** A door's fields with the one company key a record is sealed under, added the same way, for the doors that take a single key and not the keys held. */
export const withCompanyKey = <T extends object>(door: T, key: Hex): T & { readonly viewingKey: Hex } => ({ ...door, viewingKey: key });

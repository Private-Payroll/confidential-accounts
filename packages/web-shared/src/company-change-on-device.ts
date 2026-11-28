/**
 * **A CHANGE TO THE COMPANY, RAISED, APPROVED AND CARRIED OUT FROM THIS DEVICE:
 * WHO IS SEATED, THE APPROVALS NEEDED, A VAULT'S APPROVALS, A SPENDING POLICY
 * OR ITS BAR.**
 *
 * It finds a proposal already written down for the same change before writing
 * a new one, so nothing is raised twice, and counts the approvals the change
 * needs from the company's directory and the chain. Before each step it
 * refuses a change that would leave a vault unable to approve its runs, raise
 * the bar while a removal is under way, or seat a signer before the records the
 * company was founded with are anchored.
 */
import { sealingWith, type KeysHeld } from '../../../src/core/company-key.js';
import { proposalEntry, type ManifestEntryBody } from '../../../src/midnight/record-manifest.js';
import { FiledNotEntered, type RecordsEntered } from './record-entered-here.js';
import { DEVICE_RAISE_VERSION } from '../../../src/core/device-raise.js';
import type { OpenedRound, GovernanceOnTheWire, GovernedCallOrder, ProposalIdentity } from './governed-call-builder.js';
import { sameGovernance } from './governance-compared.js';
import type { AccountGovernance } from 'midnight-identity/profile/records-key';
import { commit, signingPublicKeyOf, type Hex } from '../../../src/core/crypto.js';
import {
  policyChangeRefusal,
  refuseLeavingAVaultShort,
  refusalSaid,
  seatThresholdRefusal,
  thresholdCarryBar,
  thresholdCounted,
  type ApproverRoster,
  type BandInForce,
  type SeatRights,
  type GovernanceChange as VaultCheckChange,
  type SeatThresholdChange
} from '../../../src/core/vault-approvers.js';
import { assetIdBytes, NO_ASSET } from '../../../src/core/assets.js';
import type { RetirementSignature, SealedProposal } from '../../../src/core/types.js';
import { signedStateHere, standingOnChainHere } from './run-rebuilt-here.js';
import { NotOpenedOnThisDevice } from './round-opened-here.js';
import { handedOver } from './hand-over.js';
import {
  proposalFilingRefusal,
  raiseByOf,
  sealGovernanceProposal,
  signProposalFiling,
  type GovernancePayloadBody,
  type RetirementTerms
} from '../../../src/core/proposal-filing.js';
import { removalApproversHere } from './removal-approvers-here.js';
import {
  directoryNotYetAnchored,
  FOUNDING_ASKED,
  foundedOnChainHere,
  kindAsked,
  listedHere
} from './vault-page-doors.js';
import { carryOrderHere } from './material-made-here.js';
import {
  type CarryCircuit,
  closedOnTheChainHere,
  closesOnRecord,
  counted,
  filerHere,
  type GovernedCallDoors,
  HEX64,
  hexOfBytes,
  onChainHere,
  opensFor,
  type RoundOnThePage,
  standingHere,
  theRoundAsked,
  waitFor
} from './governed-call-on-device.js';
import { ApprovalNotOwed, approveHere, NothingToApprove, retirementHanded } from './proposal-approved-on-device.js';
import { refuseABarRaisedDuringARemoval, refuseWhatALeaverFiledHere } from './seats-leaving-here.js';

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
 * itself carries out (`carryRetireHere`).
 */
export type GovernedThroughTheRecords = Exclude<
  GovernanceOnTheWire,
  { readonly kind: 'recover-anchor' } | { readonly kind: 'retire-vault' }
>;

/** Each change's kind, as a proposal's sealed record names it. */
const KIND_OF: Readonly<
  Record<
    GovernedThroughTheRecords['kind'],
    'add-signer' | 'remove-signer' | 'set-threshold' | 'set-vault-threshold' | 'set-spending-policy' | 'set-policy-bar'
  >
> = {
  'add-signer': 'add-signer',
  'remove-signer': 'remove-signer',
  threshold: 'set-threshold',
  'vault-threshold': 'set-vault-threshold',
  'spending-policy': 'set-spending-policy',
  'policy-bar': 'set-policy-bar'
};

/** The circuit that carries each change out. */
const CARRIED_BY: Readonly<Record<GovernedThroughTheRecords['kind'], CarryCircuit | null>> = {
  'add-signer': null,
  'remove-signer': 'removeSignerAndSetThreshold',
  threshold: 'setThreshold',
  'vault-threshold': 'setVaultThreshold',
  'spending-policy': 'setPolicy',
  'policy-bar': 'setPolicyBar'
};

/**
 * **THE PROPOSAL THE COMPANY ALREADY HOLDS FOR THIS CHANGE, OPENED HERE**:
 * open, written down with the salt its identity is made with, and for exactly
 * this change. The one the chain holds first, then the newest; given `proposal`,
 * only the one with that identity on the chain, so a record another seat filed
 * for the same change is never taken up in its place. Null when there is none,
 * and a new one is written down. Only open proposals of the change's own kind
 * are opened past their sealed kind: a payroll run or a one-off payment is
 * never this change, and opening one reads the company's payments, which a
 * change to who is seated does not read.
 */
async function liveRoundHere(
  doors: GovernanceDoors,
  viewingKey: KeysHeld,
  change: GovernedThroughTheRecords,
  proposal?: string
): Promise<{ round: RoundOnThePage; opened: OpenedRound; filed: SealedProposal; enteredNow: boolean } | null> {
  const { service } = doors;
  if (!service.sealedProposals) {
    throw new NotOpenedOnThisDevice(
      "This page cannot read the company's records, so it cannot find this change. Reload the " +
        'page to get the current version.'
    );
  }
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice(
      "This page cannot read the company's records, so it cannot find this change. Reload the " +
        'page to get the current version.'
    );
  }
  /*
   * Every proposal the company's records name must be in the list: one withheld is never a change with no proposal yet
   * (`listedHere`); and each stands where the chain says it does, never where the service's plain fields say.
   */
  const served = await service.sealedProposals(doors.accountId);
  const listed = await standingOnChainHere(
    doors.records,
    listedHere(await doors.records.directory(kindAsked('proposal')), 'proposal', served, 'proposal')
  );
  const candidates = listed
    .filter(
      (p) =>
        p.accountId === doors.accountId &&
        p.status === 'open' &&
        (proposal === undefined || String(p.chainId).toLowerCase() === proposal.toLowerCase())
    )
    .sort((a, b) => (a.raisedAt ? 0 : 1) - (b.raisedAt ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  const own = signingPublicKeyOf(doors.material.signingSecret as Hex);
  /* An entry of this seat's own that the company's records would not keep: said rather than raising the change twice. */
  let notEntered: unknown = null;
  for (const p of candidates) {
    let opened: OpenedRound;
    let enteredNow = false;
    try {
      opened = await opensFor(doors)(p.id, viewingKey, false, KIND_OF[change.kind]);
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
        opened = await opensFor(doors)(p.id, viewingKey, false, KIND_OF[change.kind]);
      } catch (e) {
        notEntered ??= e;
        continue;
      }
    }
    if (opened.governance === undefined || !('kind' in opened.governance)) continue;
    if (!sameGovernance(opened.governance as GovernanceOnTheWire, change)) continue;
    return {
      round: {
        id: p.id,
        chainId: p.chainId,
        status: p.status,
        approvalCount: p.approvalCount,
        ...(p.txRef === undefined ? {} : { txRef: p.txRef }),
        ...(p.raisedAt === undefined ? {} : { raisedAt: p.raisedAt }),
        ...((p as { readonly outrun?: true }).outrun === true ? { outrun: true as const } : {})
      },
      opened,
      filed: p,
      enteredNow
    };
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
  changeBatchDigest: opened.half?.changeBatchDigest ?? commit('', '')
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
  doors: GovernedCallDoors,
  round: RoundOnThePage,
  change: GovernedThroughTheRecords,
  bar?: (held: AccountGovernance) => number
): Promise<boolean> => {
  if (doors.records === undefined) return false;
  const held = (await doors.records.directory()).holders;
  if (!Number.isSafeInteger(held?.seatBar) || held.seatBar < 1) {
    throw new Error(
      "your wallet's read of the company's account did not say how many approvals a change of who is seated needs, " +
        'so this device cannot say whether the proposal has the approvals it needs. Nothing was sent. Reload the page.'
    );
  }
  const needed =
    bar !== undefined
      ? bar(held)
      : change.kind === 'add-signer' || change.kind === 'remove-signer'
        ? held.seatBar
        : change.kind === 'vault-threshold'
          ? thresholdCarryBar(
              { kind: 'vaultThreshold', vault: change.vault as Hex, threshold: Number(change.threshold) },
              held
            )
          : held.approvals;
  const asked = String(round.chainId).toLowerCase();
  const onChain =
    doors.records.roundsOnChain === undefined ? undefined : (await doors.records.roundsOnChain([asked]))[asked];
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
    throw new NotOpenedOnThisDevice(
      "This page cannot read the company's records, so it cannot seat a signer. Reload the page to " +
        'get the current version.'
    );
  }
  const why = foundedOnChainHere(await doors.records.directory(FOUNDING_ASKED));
  if (why !== null) {
    throw new Error(
      `No signer is added before the records the company was founded with are anchored on chain (${why}). ` +
        "Nothing was sent. Open the company on its founding signer's device to anchor them, then add the signer again."
    );
  }
}

/**
 * **WHAT A CHANGE TO THE COMPANY IS MADE WITH, ON THIS DEVICE**: the change, its summary and the body sealed with it,
 * and the steps the caller adds or stops at. `governOnDevice` says how each is used.
 */
interface GovernedChangeAsked {
  viewingKey: KeysHeld;
  change: GovernedThroughTheRecords;
  summary: string;
  body: GovernancePayloadBody;
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
}

/** The check made before every send of a change; given the proposal as opened, and its id, from the approval on. */
type ChangeCheck = (opened?: OpenedRound, proposalId?: string) => Promise<void>;

/** A proposal the chain holds, as the company's service lists it and as this device opened it. */
type RoundHere = { round: RoundOnThePage; opened: OpenedRound };

/*
 * **NO CHANGE THIS DEVICE RAISES, APPROVES OR CARRIES OUT LEAVES A VAULT
 * UNABLE TO PAY**: counted afresh before each, over the company as it stands
 * then, a spending policy at its bands, as well as any check the caller makes. Approved or carried out, it is
 * also refused when its seat filed it after its own removal was raised
 * (`refuseWhatALeaverFiledHere`).
 */
const changeCheckedHere =
  (doors: GovernanceDoors, input: GovernedChangeAsked): ChangeCheck =>
  async (opened, proposalId) => {
    const counts = changeCounted(input.change, input.seatRights);
    if (counts?.kind === 'seatAndThreshold') await refuseASeatThresholdHere(doors, counts);
    else if (counts?.kind === 'remove' || counts?.kind === 'removeAndThreshold') {
      refuseLeavingAVaultShort(await removalApproversHere(doors, input.viewingKey), counts, doors.vaultName);
    } else if (counts !== null) refuseLeavingAVaultShort(await doors.approvers(), counts, doors.vaultName);
    if (input.change.kind === 'add-signer') await refuseASecondSignerBeforeTheFounding(doors);
    await refuseABarRaisedDuringARemoval(doors, input.viewingKey, input.change, input.highestBand);
    if (input.change.kind === 'spending-policy')
      await refuseAPolicyLeavingAVaultShort(doors, input.change.vault, input.highestBand, input.bandsInForce);
    if (opened !== undefined && proposalId !== undefined)
      await refuseWhatALeaverFiledHere(doors, input.viewingKey, proposalId, opened);
    await input.before?.(opened);
  };

/**
 * **A CHANGE THE COMPANY HOLDS NO PROPOSAL FOR, WRITTEN DOWN HERE AND RAISED**: sealed under the company's key in
 * force and signed by this seat, checked before anything is built, and entered in the company's records once sent.
 * Returns the proposal once the chain holds its raise, or says it was sent and not yet seen.
 */
async function writtenDownAndRaisedHere(
  doors: GovernanceDoors,
  input: GovernedChangeAsked,
  check: ChangeCheck,
  blinding: () => Promise<string>
): Promise<RoundHere> {
  const { service } = doors;
  const key = input.viewingKey;
  if (!service.file)
    throw new Error(
      'This page cannot write proposals down. Reload the page to get the current version. Nothing was sent.'
    );
  await check();
  const salt = doors.filing.salt();
  const identity = await proposalIdentityOn(doors.builder)(input.change, salt);
  /* A signer invitation, by address or by a link or a code, names the proposal raised for it; raised under any other, every other device refuses it. */
  const terms = (input.body as { invited?: { terms?: { proposal?: unknown; leaf?: unknown } } }).invited?.terms;
  if (
    input.change.kind === 'add-signer' &&
    typeof terms?.proposal === 'string' &&
    terms.proposal.toLowerCase() !== String(identity.chainId).toLowerCase()
  ) {
    throw new InvitationNotBound(
      'The invitation this proposal carries names another proposal than this one, so nothing was raised. ' +
        'Nothing was sent. Invite the person again.'
    );
  }
  const change = { asset: NO_ASSET, amount: 0n, batchDigest: commit('', ''), salt: salt as Hex };
  const sealing = sealingWith(key, doors.filing.keyEpoch);
  const filing = signProposalFiling(
    doors.accountId,
    {
      id: doors.filing.newId(),
      digest: identity.digest as Hex,
      chainId: identity.chainId as Hex,
      keyEpoch: sealing.epoch,
      createdAt: new Date().toISOString(),
      sealed: sealGovernanceProposal({
        accountId: doors.accountId,
        viewingKey: sealing.key,
        kind: KIND_OF[input.change.kind],
        summary: input.summary,
        noVault: identity.noVault as Hex,
        body: input.body,
        change,
        proposedBy: doors.filing.seat
      })
    },
    doors.material.signingSecret as Hex
  );
  const raisedRetirement = (input.body as { retirement?: RetirementTerms }).retirement;
  const opened: OpenedRound = {
    chainId: identity.chainId,
    digest: identity.digest,
    vault: identity.noVault,
    salt,
    summary: input.summary,
    filedBy: filing.filedBy.publicKey,
    raiseBy: raiseByOf(filing.createdAt),
    governance: input.change,
    half: { assetId: hexOfBytes(NO_ASSET_NAMED.assetId), changeAmount: '0', changeBatchDigest: change.batchDigest },
    ...(raisedRetirement === undefined ? {} : { retirement: raisedRetirement })
  };
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account,
    material: doors.material,
    chain,
    opened,
    order: {
      circuit: 'propose',
      governance: input.change,
      half: governanceHalf(salt, opened, await blinding()),
      proposal: identity.chainId
    }
  });
  doors.progress?.('sending');
  const file = service.file;
  const answer = await handedOver(doors.handOver, {
    tx,
    call: { kind: 'account-call', contract: chain.account, circuit: 'propose' },
    viaService: () => file(doors.accountId, { proposal: filing, tx, version: DEVICE_RAISE_VERSION, salt }),
    before: () => file(doors.accountId, { proposal: filing, salt }),
    after: () => service.standing(filing.id)
  });
  const sent = await onChainHere(doors, theRoundAsked(answer, filing.id, identity.chainId));
  await proposalEntered(doors, proposalEntry(doors.accountId, filing));
  const round = sent.raisedAt
    ? sent
    : await waitFor(doors, 'this proposal', filing.id, (r) => Boolean(r.raisedAt), sent);
  return { round, opened };
}

/**
 * **A PROPOSAL WRITTEN DOWN AND NOT YET RAISED, SENT AGAIN AS ITS RAISE**, checked as a raise before anything is built.
 * Returns the proposal once the chain holds its raise, or says it was sent and not yet seen.
 */
async function sentAgainHere(
  doors: GovernanceDoors,
  input: GovernedChangeAsked,
  check: ChangeCheck,
  blinding: () => Promise<string>,
  round: RoundOnThePage
): Promise<RoundHere> {
  const { service } = doors;
  /* Opened again for a send: the half of its raise, the change it seals, is read only for one. */
  const opened = await opensFor(doors)(round.id, input.viewingKey, true);
  /* Sent again, it is still a raise: checked as one before anything is built, and refused if a signer on their way out filed it. */
  await check();
  await refuseWhatALeaverFiledHere(doors, input.viewingKey, round.id, opened);
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account,
    material: doors.material,
    chain,
    opened,
    order: {
      circuit: 'propose',
      governance: input.change,
      half: governanceHalf(opened.salt, opened, await blinding()),
      proposal: opened.chainId
    }
  });
  doors.progress?.('sending');
  const answer = await handedOver(doors.handOver, {
    tx,
    call: { kind: 'account-call', contract: chain.account, circuit: 'propose' },
    viaService: () => service.send(round.id, { tx, version: DEVICE_RAISE_VERSION, filer: filerHere(doors) }),
    after: () => service.standing(round.id)
  });
  const sent = await onChainHere(doors, theRoundAsked(answer, round.id, opened.chainId));
  return {
    round: sent.raisedAt ? sent : await waitFor(doors, 'this proposal', round.id, (r) => Boolean(r.raisedAt), sent),
    opened
  };
}

/**
 * **THIS SEAT'S APPROVAL OF A CHANGE, WHERE IT OWES ONE.** A seat that raised it here has approved it by the raise and
 * only hands its retirement signature; any other approves while the change is short of its bar. Returns, tagged so
 * that nothing the service sent can be read as an outcome, where the proposal stands after it, or that it waits for
 * approvals when asked only to carry out.
 */
async function approvedByThisSeatHere(
  doors: GovernanceDoors,
  input: GovernedChangeAsked,
  check: ChangeCheck,
  live: RoundHere,
  raisedHere: boolean
): Promise<{ readonly approved: RoundOnThePage } | { readonly waiting: GovernedOutcome }> {
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
    if (input.carryOnly === true) return { waiting: { state: 'waiting-for-approvals', round } };
    await check(opened, round.id);
    const retirement = await input.signs?.(opened, round);
    const done = await approveHere(
      doors,
      { round, viewingKey: input.viewingKey, of, ...(retirement === undefined ? {} : { retirement }) },
      true
    );
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
  return { approved: round };
}

/**
 * **A CHANGE AT ITS BAR, CARRIED OUT FROM THIS DEVICE**, checked again first, with the order made from the proposal as
 * this device opened it. A change short of its bar waits for approvals, an invitation waits for the invitee, and a
 * caller that carries out in a step of its own is told the change is ready.
 */
async function carriedOutHere(
  doors: GovernanceDoors,
  input: GovernedChangeAsked,
  check: ChangeCheck,
  opened: OpenedRound,
  round: RoundOnThePage
): Promise<GovernedOutcome> {
  const { service } = doors;
  if (!(await meetsTheBar(doors, round, input.change, input.bar))) return { state: 'waiting-for-approvals', round };
  const carryCircuit = CARRIED_BY[input.change.kind];
  if (carryCircuit === null) return { state: 'waiting-for-the-invitee', round };
  if (input.stopBeforeCarry === true) return { state: 'ready-to-carry', round };
  if (!service.carry)
    throw new Error(
      'This page cannot carry out proposals. Reload the page to get the current version. Nothing was sent.'
    );
  await check(opened, round.id);
  await input.beforeCarry?.(opened, round);
  /* What carries it out is made here, from the proposal as this device opened it. */
  const order = input.carry === undefined ? carryOrderHere(opened) : input.carry(opened);
  const carried = order as { circuit?: string; proposal?: string };
  if (
    carried.circuit !== carryCircuit ||
    String(carried.proposal).toLowerCase() !== String(round.chainId).toLowerCase()
  ) {
    throw new Error(
      "the company's record of this proposal is not the change asked for here. Nothing was built or sent. " +
        'Reload the page and try again.'
    );
  }
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account,
    order,
    material: doors.material,
    chain,
    opened
  });
  doors.progress?.('sending');
  const carry = service.carry;
  const done = theRoundAsked(
    await handedOver(doors.handOver, {
      tx,
      call: { kind: 'account-call', contract: chain.account, circuit: carryCircuit },
      viaService: () => carry(round.id, { tx, circuit: carryCircuit, filer: filerHere(doors) }),
      before: async () => {
        closesOnRecord(service);
      },
      after: () => closedOnTheChainHere(doors, round.id, round.chainId, 'carried')
    }),
    round.id,
    round.chainId
  );
  return { state: 'done', round: done };
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
async function governOnDevice(doors: GovernanceDoors, input: GovernedChangeAsked): Promise<GovernedOutcome> {
  const check = changeCheckedHere(doors, input);
  const key = input.viewingKey;
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice(
      "This page cannot read the company's records, so it cannot raise or carry out this " +
        'change. Reload the page to get the current version.'
    );
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
  if (
    found !== null &&
    !found.enteredNow &&
    found.filed.filedBy?.publicKey.toLowerCase() === signingPublicKeyOf(doors.material.signingSecret as Hex)
  ) {
    await proposalEntered(doors, proposalEntry(doors.accountId, found.filed));
  }
  let live: { round: RoundOnThePage; opened: OpenedRound } | null = found;
  /* Whether this attempt sent the raise: a raise counts as its raiser's approval on the chain. */
  let raisedHere = false;
  /* A device that only approves sends no raise: not a new proposal, and not one the company holds that the chain has not raised. */
  if (
    input.approveOnly !== undefined &&
    (live === null ||
      !live.round.raisedAt ||
      String(live.round.chainId).toLowerCase() !== input.approveOnly.toLowerCase())
  ) {
    throw new NothingToApprove();
  }
  if (live === null) {
    live = await writtenDownAndRaisedHere(doors, input, check, blinding);
    raisedHere = true;
  } else if (!live.round.raisedAt) {
    live = await sentAgainHere(doors, input, check, blinding, live.round);
    raisedHere = true;
  }
  const after = await approvedByThisSeatHere(doors, input, check, live, raisedHere);
  if ('waiting' in after) return after.waiting;
  return carriedOutHere(doors, input, check, live.opened, after.approved);
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
      again:
        'The proposal is written down and raised. Make this change again from this page: this device finds the proposal it ' +
        'wrote down and enters it, and nothing is raised twice.'
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
export async function riseWaitsForTheDirectory(doors: GovernanceDoors, threshold: number): Promise<void> {
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice(
      "This page cannot read the company's records, so it cannot raise the threshold. Reload the page to " +
        'get the current version.'
    );
  }
  let here = await doors.records.directory();
  if (threshold <= here.holders.approvals) return;
  if (directoryNotYetAnchored(here).length > 0 && doors.anchorDirectory !== undefined) {
    await doors.anchorDirectory();
    here = await doors.records.directory();
  }
  const left = directoryNotYetAnchored(here);
  if (left.length > 0) {
    throw new Error(
      `The approval threshold is not raised while ${left.length > 1 ? 'versions' : 'version'} ${left.join(', ')} of the ` +
        `company's directory ${left.length > 1 ? 'are' : 'is'} filed and not yet anchored: raised first, a change not yet anchored ` +
        'would be counted at the higher threshold and could be lost. Nothing was sent. Open the company on the device of a seat ' +
        'that may anchor, which anchors them at once, then raise the threshold again.'
    );
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
  doors: GovernanceDoors,
  vault: string,
  highestBand: number | undefined,
  bandsInForce: (() => Promise<readonly BandInForce[]>) | undefined
): Promise<void> {
  if (highestBand === undefined || bandsInForce === undefined) {
    throw new NotOpenedOnThisDevice(
      'This device was not told the bands of the spending policies in force, so it cannot count who ' +
        "approves the vault's runs at its bands. Nothing was sent. Reload the page to get the current version."
    );
  }
  const no = policyChangeRefusal(
    await doors.approvers(),
    await bandsInForce(),
    { vault, band: highestBand },
    doors.vaultName
  );
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
      throw new NotOpenedOnThisDevice(
        'This device was not told which rights the invited seat carries, so it cannot count who approves each ' +
          "vault's runs once this seat is taken. Nothing was sent. Reload the page to get the current version."
      );
    }
    return { kind: 'seatAndThreshold', rights: seatRights, threshold: t };
  }
  if (change.kind === 'remove-signer') {
    const t = thresholdCounted(change.threshold, true);
    return t === 0
      ? { kind: 'remove', leaf: change.leaf.toLowerCase() as Hex }
      : { kind: 'removeAndThreshold', leaf: change.leaf.toLowerCase() as Hex, threshold: t };
  }
  if (change.kind === 'threshold') return { kind: 'threshold', threshold: thresholdCounted(change.threshold) };
  if (change.kind === 'spending-policy' || change.kind === 'policy-bar') return null;
  return {
    kind: 'vaultThreshold',
    vault: change.vault.toLowerCase() as Hex,
    threshold: thresholdCounted(change.threshold)
  };
};

/**
 * **A SEAT ADDED WITH A NEW THRESHOLD IS CHECKED AS THE CHAIN WILL CHECK IT, AND FOR EVERY VAULT**
 * (`seatThresholdRefusal`): no higher than the seats the person's own wallet reads on the chain now and the one the
 * invitation adds, and leaving no vault short of signers who may approve its runs, the new seat counted on the vaults
 * its rights reach. A rise then waits for every directory change filed to be anchored, as any rise of the threshold does.
 */
async function refuseASeatThresholdHere(doors: GovernanceDoors, change: SeatThresholdChange): Promise<void> {
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice(
      "This page cannot read the company's records, so it cannot seat a signer with a new threshold. " +
        'Reload the page to get the current version.'
    );
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

export const stepsOf = (o: ThresholdChangeSteps) => ({
  ...(o.approveOnly === undefined ? {} : { approveOnly: o.approveOnly }),
  ...(o.stopBeforeCarry === undefined ? {} : { stopBeforeCarry: o.stopBeforeCarry }),
  ...(o.carryOnly === undefined ? {} : { carryOnly: o.carryOnly })
});

/** Changes the account's threshold, as far as this device can: see `governOnDevice`. */
export function changeThresholdOnDevice(
  doors: GovernanceDoors,
  input: { viewingKey: KeysHeld; newThreshold: number; seated: number } & ThresholdChangeSteps
): Promise<GovernedOutcome> {
  if (!Number.isInteger(input.newThreshold) || input.newThreshold < 1) {
    return Promise.reject(new Error('the threshold must be a whole number, at least one. Nothing was sent.'));
  }
  return governOnDevice(doors, {
    viewingKey: input.viewingKey,
    change: { kind: 'threshold', threshold: String(input.newThreshold) },
    summary: `Change the approval threshold to ${input.newThreshold} of ${input.seated}`,
    body: { newThreshold: input.newThreshold },
    before: async () => {
      await riseWaitsForTheDirectory(doors, input.newThreshold);
      await input.before?.();
    },
    ...stepsOf(input)
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
  input: { viewingKey: KeysHeld; vault: string; newThreshold: number; seated: number } & ThresholdChangeSteps
): Promise<GovernedOutcome> {
  if (!Number.isInteger(input.newThreshold) || input.newThreshold < 1) {
    return Promise.reject(
      new Error("a vault's approvals needed must be a whole number, at least one. Nothing was sent.")
    );
  }
  if (!HEX64.test(input.vault)) return Promise.reject(new Error("that is not a vault's address. Nothing was sent."));
  if (input.newThreshold > input.seated) {
    return Promise.reject(
      new Error(
        `a vault cannot need more approvals than the ${input.seated} signers the company has seated, ` +
          'or nothing from it could ever be approved. Seat more signers first, or choose a smaller number. Nothing was sent.'
      )
    );
  }
  return governOnDevice(doors, {
    viewingKey: input.viewingKey,
    change: { kind: 'vault-threshold', vault: input.vault, threshold: String(input.newThreshold) },
    summary: `Set this vault's approval threshold to ${input.newThreshold} of ${input.seated}`,
    body: { vault: input.vault as Hex, newThreshold: input.newThreshold },
    before: async () => {
      await riseWaitsForTheDirectory(doors, input.newThreshold);
      await input.before?.();
    },
    ...stepsOf(input)
  });
}

export { governOnDevice };

/** The address and rights an invitation raises are not the ones a seat that may invite signed. Nothing was raised. */
export class InvitationNotBound extends Error {
  constructor(why: string) {
    super(why);
    this.name = 'InvitationNotBound';
  }
}

/** The builder's working-out of a proposal's identity on this page; refused, with nothing sent, on a page that has none. */
export const proposalIdentityOn =
  (builder: GovernanceDoors['builder']) =>
  (change: GovernanceOnTheWire, salt: string): Promise<ProposalIdentity> => {
    if (builder.proposalIdentity === undefined) {
      throw new Error(
        "This page cannot work out a proposal's identity. Reload the page to get the current version. Nothing was sent."
      );
    }
    return builder.proposalIdentity(change, salt);
  };

/**
 * The invitation to a seat is open on the chain and can never seat anyone: a signer was removed or replaced since it was
 * raised, so the account refuses the seat it offers (`requireApproved`). Nothing was approved or sent.
 */
export class InvitationOutrun extends Error {
  readonly nothingWasSent = true;
  constructor() {
    super(
      'a signer was removed or replaced since this invitation was raised, so it can no longer seat anyone. Nothing was ' +
        'approved or sent. Withdraw it, and invite the person again.'
    );
    this.name = 'InvitationOutrun';
  }
}

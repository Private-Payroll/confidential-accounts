/**
 * **RAISING A PAYROLL PROPOSAL AND APPROVING ONE, FROM THIS DEVICE.**
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
 * signer; **the screen does not yet say the first of the three any differently
 * from any other failure.**
 */
import { assets as theAssets, symbolOf, type AssetId, type AssetRegistry, type LedgerForm } from '../../../src/core/assets.js';
import { refuseWhatTheVaultCannotPay, type PaymentAsked, type VaultHoldings } from '../../../src/core/vault-holdings.js';
import {
  DEVICE_RAISE_VERSION, WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED, paymentChecked, paymentsCheckedDigest, type PaymentChecked,
} from '../../../src/core/device-raise.js';
import type {
  SignerMaterial, OpenedRound, RaiseRunOrder, GovernanceOnTheWire,
} from './governed-call-builder.js';
import { commit, parseCanonical, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import {
  EVERY_RIGHT, refuseLeavingAVaultShort, type ApproverRoster, type GovernanceChange as VaultCheckChange,
} from '../../../src/core/vault-approvers.js';
import { openFromInbox, openRecord } from '../../../src/core/sealed-records.js';
import { openAccount } from '../../../src/core/account.js';
import { refuseASeatKeyNotFromTheInvitee, SeatKeyNotFromTheInvitee } from '../../../src/core/seat-invite-proof.js';
import { assetIdBytes, NO_ASSET } from '../../../src/core/assets.js';
import type { PendingSignerPayload, SealedAccount, SealedProposal } from '../../../src/core/types.js';
import type { StateChange } from '../../../src/core/ledger.js';
import { payrollRoundOf, sameList, untoldRetryRounds } from '../../../src/core/retry-cover.js';
import type { AccountCallChainOnTheWire, VaultBuilderClient } from './vault-worker-client.js';
import {
  openedRunHere, runRebuiltHere, signedStateHere, whatTheRecordsAccountFor, type CompanyRecordsHere,
} from './run-rebuilt-here.js';
import { raiseLegHere, raiseRetryHere, type LegRaiseDoors } from './run-raised-here.js';
import type { SignedRunFiling } from '../../../src/core/run-filing.js';
import {
  paysCommitmentOf, proposalFilingRefusal, sealGovernanceProposal, signProposalFiling, type GovernancePayloadBody,
  type SignedProposalFiling,
} from '../../../src/core/proposal-filing.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import { judgeIn } from './vault-page-doors.js';
import { admitSignerHere, NO_ROSTER_RECORD, rosterHere, waitingHere, type RosterDoors } from './roster-here.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import {
  carryOrderHere, legPaymentsHere, raiseOrderHere, retryOrderHere, retryPaymentsHere, NotMadeHere,
} from './material-made-here.js';

/** A proposal written down and not yet sent, as the service hands it to the device that builds it. */
export interface RaiseOrderOnTheWire {
  readonly proposalId: string;
  readonly chainId: string;
  readonly order: RaiseRunOrder;
  /** The digest of the payments the proposal written down pays, taken as `paymentsCheckedDigest` takes it. */
  readonly paymentsChecked: string;
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
  /** What the person is shown for it, when the page shows it. */
  readonly summary?: string;
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

/** The approvals the account and its vaults need, as the chain holds them. */
interface BarsOnTheChain {
  readonly threshold: number;
  readonly vaultThresholds: ReadonlyArray<{ readonly vault: string; readonly threshold: number }>;
}

/** A proposal's raise, approval, withdrawal or carrying out, as the service relays it: a proven call and nothing else. */
export interface GovernedCallService {
  callState(accountId: string): Promise<AccountCallChainOnTheWire & { readonly account: string }>;
  /** A proposal's raise this device proved, sent. */
  send(proposalId: string, body: { tx: string; version: typeof DEVICE_RAISE_VERSION }): Promise<RoundOnThePage>;
  /** An approval this device proved, sent. */
  approve(proposalId: string, body: { tx: string }): Promise<RoundOnThePage>;
  /** Where a proposal stands on the chain now. Sends nothing. */
  standing(proposalId: string): Promise<RoundOnThePage>;
  /** A withdrawal: the call this device proved when the chain holds the proposal, none when it was only written down. */
  cancel?(proposalId: string, body: { tx?: string }): Promise<RoundOnThePage>;
  /** A governance proposal this device sealed and signed, written down, and its raise sent with it. */
  file?(accountId: string, body: {
    proposal: SignedProposalFiling; tx: string; version: typeof DEVICE_RAISE_VERSION;
    /** The proposal's salt, so the service can hold its identity on the chain to the vault it names, or to none. */
    salt: string;
    /** A payroll run's leg: the run re-filed as raised, and what the raise pays, a kind, a token and an amount each. */
    run?: SignedRunFiling;
    pays?: { vault: string; asset: string; payments: ReadonlyArray<{ kind: 'shielded' | 'unshielded'; token: string; amount: string }> };
  }): Promise<RoundOnThePage>;
  /** An approved governance proposal carried out by the call this device proved. */
  carry?(proposalId: string, body: { tx: string; circuit: CarryCircuit }): Promise<RoundOnThePage>;
  /** The approvals the account and each vault need, as the chain holds them now. */
  bars?(accountId: string): Promise<BarsOnTheChain>;
  /** The company's own records, sealed as they are stored, for this device to open itself. */
  sealedProposals?(accountId: string): Promise<SealedProposal[]>;
  sealedAccount?(accountId: string): Promise<SealedAccount>;
}

/** The calls that carry out an approved governance proposal. */
type CarryCircuit = 'amendSigner' | 'setThreshold' | 'setVaultThreshold';

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
   * Opens one proposal from the company's sealed records on this device. The
   * company's own records, through `openTheRoundHere`, when not given.
   */
  readonly opens?: (proposalId: string, viewingKey: string, forARaise: boolean) => Promise<OpenedRound>;
  /**
   * The company's records a payroll run is read from on this device, so that
   * an approval of one is built only for the run made again here. Without
   * them a payroll proposal is not approved from this device.
   */
  readonly records?: CompanyRecordsHere;
  /**
   * What a raise or a retry is built from and checked against, made on this
   * device from the company's records (`material-made-here.ts`) when not given.
   */
  readonly made?: MadeHereDoors;
  /** How long to wait for the chain to show what was sent, and how often to ask. */
  readonly waitMs?: number;
  readonly everyMs?: number;
}

/** What a raise or a retry is built from and checked against, each made on this device. */
export interface MadeHereDoors {
  legPayments(runId: string, viewingKey: string, which?: { asset?: string; form?: LedgerForm }): Promise<LegPaymentsOnTheWire>;
  retryPayments(runId: string, viewingKey: string, indices: readonly number[], which?: { asset?: string; form?: LedgerForm }): Promise<LegPaymentsOnTheWire>;
  raiseOrder(runId: string, viewingKey: string, which?: { asset?: string; form?: LedgerForm }): Promise<RaiseOrderOnTheWire>;
  retryOrder(runId: string, viewingKey: string, proposalId: string, which?: { asset?: string; form?: LedgerForm }): Promise<RetryOrderOnTheWire>;
}

/** Everything a raise or a retry is made from, from the company's records this device opens. */
const madeFromTheRecords = (records: CompanyRecordsHere, accountId: string): MadeHereDoors => ({
  legPayments: (runId, viewingKey, which) => legPaymentsHere(records, accountId, runId, viewingKey as Hex, which),
  retryPayments: (runId, viewingKey, indices, which) => retryPaymentsHere(records, accountId, runId, viewingKey as Hex, indices, which),
  raiseOrder: (runId, viewingKey, which) => raiseOrderHere(records, accountId, runId, viewingKey as Hex, which),
  retryOrder: (runId, viewingKey, proposalId, which) => retryOrderHere(records, accountId, runId, viewingKey as Hex, proposalId, which),
});

/** What this device makes a raise or a retry from: the doors given, or the company's records. */
const madeFor = (doors: GovernedCallDoors): MadeHereDoors => {
  if (doors.made !== undefined) return doors.made;
  if (doors.records === undefined) {
    throw new NotMadeHere('This page cannot read the company\'s records, so it cannot make a raise or a retry here. Reload '
      + 'the page to get the current version.');
  }
  return madeFromTheRecords(doors.records, doors.accountId);
};

const HEX64 = /^[0-9a-f]{64}$/u;
const hexOfBytes = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Why this device could not read the company's record of a proposal itself. Nothing is built without it. */
export class NotOpenedOnThisDevice extends Error {
  constructor(why: string, options?: { cause?: unknown }) {
    super(`${why} Nothing was built or sent.`, options);
    this.name = 'NotOpenedOnThisDevice';
  }
}

/** Kinds a device here acts on. Any other is refused before anything is read out of it. */
const KINDS_A_DEVICE_ACTS_ON = new Set(['payroll', 'add-signer', 'set-threshold', 'set-vault-threshold']);

/**
 * **ONE PROPOSAL, READ ON THIS DEVICE FROM THE COMPANY'S OWN RECORDS.**
 *
 * The proposal's record is opened with the viewing key this device holds, and
 * the payload sealed inside it with the same key: that is where the salt its
 * identity was made with is kept, what a seat or a threshold change changes,
 * and, for a raise, the change the proposal commits to. The leaf of a person to
 * be seated is read from the company's roster, opened here too. What is
 * returned is what the call is checked against and proved with
 * (`refuseWhatThisDeviceDidNotOpen`).
 *
 * **THE LIMITS, SAID PLAINLY.** Every one of these records is sealed under the
 * viewing key, and the service is handed that key, so a service that rewrote a
 * record whole and sealed it again would be read here as written. The identity
 * and the payload it is made from sit on the record beside the sealed part,
 * not inside it. A person waiting for a seat is read from what they left in
 * the company's inbox, which is sealed to a key anybody may seal to, so their
 * keys are taken only with the proof their invitation gave them. What
 * this closes is a service that sends a device values other than its own
 * records hold: a salt, an identity, a leaf, a run or a change the records do
 * not name.
 *
 * **A PAYROLL RUN IS ALSO MADE AGAIN HERE** (`runRebuiltHere`): its payees'
 * addresses come from the people this device believes, its secrets from the
 * state the founding seat signed, and its leaves, root and payload are worked
 * out again where the approval is built. Who the run names and what it pays
 * each of them are still read from the run as the service stored it.
 */
export async function openTheRoundHere(
  service: GovernedCallService, accountId: string, proposalId: string, viewingKey: string, forARaise: boolean,
  records?: CompanyRecordsHere,
): Promise<OpenedRound> {
  const key = viewingKey as Hex;
  if (!service.sealedProposals) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot check this proposal. Reload '
      + 'the page to get the current version.');
  }
  const rec = (await service.sealedProposals(accountId)).find((r) => r.id === proposalId);
  if (!rec || rec.accountId !== accountId) {
    throw new NotOpenedOnThisDevice('This company\'s records hold no proposal by that name. It may have been withdrawn. '
      + 'Reload the page to see where it stands.');
  }
  let envelope: { kind: string; summary: string; vault: string; sealedPayload: Sealed };
  let body: { signerId?: unknown; newThreshold?: unknown; vault?: unknown; __change?: StateChange };
  try {
    envelope = openRecord('proposals', rec.accountId, rec.sealed, key);
    if (!KINDS_A_DEVICE_ACTS_ON.has(envelope.kind)) {
      throw new NotOpenedOnThisDevice('This page acts on payroll runs, access for new signers and changes to the approvals '
        + 'required by the company or by one of its vaults, and this proposal is none of those, so it cannot be approved '
        + 'from this device yet. Leave it unapproved.');
    }
    body = parseCanonical(unseal(envelope.sealedPayload, key));
  } catch (e) {
    if (e instanceof NotOpenedOnThisDevice) throw e;
    throw new NotOpenedOnThisDevice('This device cannot read the company\'s record of this proposal, so it cannot check it. '
      + 'Reload the page and try again. If it happens again, do not act on this proposal.', { cause: e });
  }
  const change = body.__change;
  if (!change || typeof change.salt !== 'string' || !HEX64.test(change.salt)) {
    throw new NotOpenedOnThisDevice('This proposal\'s record is incomplete, so this device cannot check it. Withdraw the '
      + 'proposal and raise it again.');
  }
  /*
   * **A RUN THAT PAYS NOTHING IS A VAULT'S SET-UP STEP, NOT A PAYROLL RUN.** A vault's first secret is set by a run in no
   * asset, and it is approved only from setting that vault up, where every key the secret is sealed to is checked
   * first. One reached through this door would skip that check, so it is refused here.
   */
  if (envelope.kind === 'payroll' && String(change.asset).toLowerCase() === NO_ASSET) {
    throw new NotOpenedOnThisDevice('This proposal pays nothing: it sets up one of the company\'s vaults, and it is '
      + 'approved only from setting that vault up, where who it is sealed to is checked. Leave it unapproved here, and '
      + 'open the vault to finish setting it up.');
  }
  let governance: GovernanceOnTheWire | undefined;
  if (envelope.kind === 'add-signer') {
    if (!service.sealedAccount) {
      throw new NotOpenedOnThisDevice('This page cannot read the company\'s list of signers, so it cannot check this '
        + 'proposal. Reload the page to get the current version.');
    }
    let leaf: string | null | undefined;
    try {
      const sealedAccount = await service.sealedAccount(accountId) as SealedAccount & { roster?: SealedCompanyRecord | null };
      /* The signers are read only from the company's roster record, never from a list on its account record. */
      if ((sealedAccount.roster ?? null) === null) throw new NotOpenedOnThisDevice(NO_ROSTER_RECORD);
      const signers = openAccount(sealedAccount, key, sealedAccount.roster).signers;
      const named = signers.find((x) => x.id === body.signerId);
      /*
       * **ONLY A PERSON WAITING FOR A SEAT IS SEATED, AT THE LEAF THEIR OWN
       * PROOF CARRIES.** A roster entry is filed whole by any seat, so a leaf
       * read from one is not taken as the seat to raise or approve.
       */
      leaf = undefined;
      /*
       * **A PERSON WAITING FOR A SEAT IS READ FROM THE INBOX, AND THE INBOX
       * TAKES ANYBODY'S WRITE.** So the keys found there are seated only if
       * they carry the invitee's proof, made with the secret in their link,
       * which this device works out again from the viewing key. A key put
       * there by somebody without that key carries no proof that passes, and
       * is refused here, before anything is built or approved.
       */
      if (named?.status === 'pending') {
        const box = sealedAccount.pendingSigners.find((p) => p.id === named.id);
        if (!box) {
          throw new SeatKeyNotFromTheInvitee('This person\'s acceptance could not be found. Access was not granted and '
            + 'nothing was sent. Reload the page; if they are still shown as waiting, press Grant access again.');
        }
        const waiting = openFromInbox<PendingSignerPayload>(box.sealed, accountId, key);
        refuseASeatKeyNotFromTheInvitee(key, accountId, waiting);
        /* The same keys as somebody already on the list is the same person twice, or a copy. */
        if (signers.some((x) => x.id !== named.id && (x.signingPublicKey === waiting.signingPublicKey
          || (x.leafCommitment ?? '').toLowerCase() === waiting.leafCommitment.toLowerCase()))) {
          throw new SeatKeyNotFromTheInvitee('These keys already belong to another signer on this company, so they '
            + 'cannot be given access under this name. Access was not granted and nothing was sent. Do not give this '
            + 'person access: they need a new invitation, and check with them that they were the one who accepted.');
        }
        leaf = waiting.leafCommitment;
      }
    } catch (e) {
      if (e instanceof SeatKeyNotFromTheInvitee || e instanceof NotOpenedOnThisDevice) throw e;
      throw new NotOpenedOnThisDevice('This device cannot read the company\'s list of signers, so it cannot check this '
        + 'proposal. Reload the page and try again. If it happens again, do not act on this proposal.', { cause: e });
    }
    if (typeof leaf !== 'string') {
      throw new NotOpenedOnThisDevice('The person this proposal gives access to is not waiting for a seat on the company\'s '
        + 'list of signers. Withdraw this proposal, then grant access again.');
    }
    governance = { kind: 'add-signer', leaf };
  } else if (envelope.kind === 'set-threshold') {
    if (typeof body.newThreshold !== 'number') {
      throw new NotOpenedOnThisDevice('This proposal does not say how many approvals it requires. Withdraw it and make the '
        + 'change again.');
    }
    governance = { kind: 'threshold', threshold: String(body.newThreshold) };
  } else if (envelope.kind === 'set-vault-threshold') {
    if (typeof body.newThreshold !== 'number' || typeof body.vault !== 'string' || !HEX64.test(body.vault)) {
      throw new NotOpenedOnThisDevice('This proposal does not say which vault it is for, or how many approvals that vault '
        + 'would need. Withdraw it and make the change again.');
    }
    governance = { kind: 'vault-threshold', vault: body.vault, threshold: String(body.newThreshold) };
  }
  /*
   * **A PROPOSAL A SEAT'S DEVICE WROTE DOWN IS BELIEVED ONLY AS THAT SEAT FILED
   * IT**: its filing signed by a key this device's own read of the company's
   * directory holds for a seat whose role may raise proposals. One the service
   * wrote down itself carries no filing, and is read as before.
   */
  if (rec.filedBy !== undefined) {
    if (records === undefined) {
      throw new NotOpenedOnThisDevice('This page cannot read the company\'s directory, so it cannot check who wrote this '
        + 'proposal down. Reload the page to get the current version.');
    }
    const why = proposalFilingRefusal(accountId, rec) ?? judgeIn(await records.directory())(
      rec.filedBy.publicKey, 'proposal', companyRecordKey('proposal', rec.id), 1);
    if (why !== null) {
      throw new NotOpenedOnThisDevice(`This device does not believe the company's record of this proposal (${why}). Do not `
        + 'act on it.');
    }
  }
  /*
   * **A PAYROLL RUN IS APPROVED ONLY AS THIS DEVICE READS IT FROM THE
   * COMPANY'S RECORDS**, and made again from them where the approval is built.
   */
  let made: OpenedRound['made'];
  if (envelope.kind === 'payroll') {
    if (records === undefined) {
      throw new NotOpenedOnThisDevice('This page cannot read the company\'s records a payroll run is checked against, so it '
        + `cannot ${forARaise ? 'raise' : 'approve'} one. Reload the page to get the current version.`);
    }
    const rebuilt = await runRebuiltHere(records, accountId, rec.id, key);
    made = rebuilt;
    /*
     * **WHAT THE FILING SAID IT PAYS IS WHAT THIS DEVICE WOULD PAY**: the vault
     * the service checked is the proposal's, and the payments are the run's as
     * built again here, so a raise cannot pass the vault's public money check on
     * payments other than its own.
     */
    if (rec.filedBy !== undefined) {
      const paying = rebuilt.retry === undefined ? rebuilt.facts : rebuilt.retry.map((i) => rebuilt.facts[i]!);
      const pays = paysCommitmentOf({ vault: envelope.vault, asset: String(change.asset), payments: paying.map(paymentChecked) }, change.salt);
      if (String(rec.pays ?? '').toLowerCase() !== pays) {
        throw new NotOpenedOnThisDevice('What the company\'s record of this proposal says it pays is not what this device '
          + 'builds the run to pay, from the vault it names. Do not act on it.');
      }
    }
    /* A raise is also checked against what the chain holds beyond the company's records. */
    if (forARaise) {
      const kept = (await records.runs()).find((r) => r.accountId === accountId && (r.proposalIds ?? []).includes(rec.id))!;
      made = { ...made, raising: await whatTheRecordsAccountFor(records, accountId, await openedRunHere(records, accountId, kept.id, key), key) };
    }
  }
  let half: OpenedRound['half'];
  if (forARaise) {
    /* The account's own name for the asset, which is what the asset witness answers with. */
    const named = { assetId: assetIdBytes(change.asset) };
    half = { assetId: hexOfBytes(named.assetId), changeAmount: String(change.amount), changeBatchDigest: change.batchDigest };
  }
  return {
    chainId: rec.chainId, digest: rec.digest, vault: envelope.vault, salt: change.salt, summary: envelope.summary,
    ...(governance === undefined ? {} : { governance }), ...(half === undefined ? {} : { half }),
    ...(made === undefined ? {} : { made }),
  };
}

const opensFor = (doors: GovernedCallDoors) => doors.opens
  ?? ((proposalId: string, viewingKey: string, forARaise: boolean) =>
    openTheRoundHere(doors.service, doors.accountId, proposalId, viewingKey, forARaise, doors.records));

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

/** The service's own mark of whether a refused send reached the chain, kept rather than guessed. */
export const nothingWasSentBy = (e: unknown): boolean =>
  (e as { nothingWasSent?: unknown } | null)?.nothingWasSent === true
  || /Nothing was sent/u.test(String((e as { message?: unknown } | null)?.message ?? ''));

const counted = (r: RoundOnThePage): number => (typeof r.approvalCount === 'number' ? r.approvalCount : 0);

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

/** Asks where a proposal stands until `seen` says so, or until the wait is over. */
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
      now = await doors.service.standing(proposalId);
    } catch {
      /* A read that failed says nothing about what was sent; ask again. */
      continue;
    }
    if (seen(now)) return now;
  }
  throw new SentAndNotYetSeen(what, now);
};

/**
 * Builds the proposal written down, sends it, and waits for the chain to hold
 * it. **What it is built from is made on this device from the company's
 * records**, never handed over by the service. **The vault is checked on this
 * device first, every time** - a first send and a send again alike - because a
 * proposal written down days ago is paid from the vault as it is now. The send
 * carries the digest of what was checked, and the service refuses it unless
 * that is the proposal it wrote down.
 */
export async function sendRaiseFromDevice(
  doors: RaiseDoors,
  input: {
    runId: string; viewingKey: string; asset?: string; form?: LedgerForm;
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
  return buildAndSend(doors, order, input.viewingKey, (tx) => service.send(order.proposalId, { tx, version: DEVICE_RAISE_VERSION }));
}

/** Builds and proves what the service wrote down, hands it to `send`, and waits for the chain to hold it. */
async function buildAndSend(
  doors: GovernedCallDoors, order: RaiseOrderOnTheWire, viewingKey: string,
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
  const sent = await send(tx);
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
 * **WHETHER THE VAULT CAN PAY THIS LEG'S PRIVATE PAYMENTS, ASKED HERE BEFORE THE
 * SERVICE IS ASKED TO WRITE ANYTHING DOWN.** The vault's notes are opened on
 * this device and nowhere else, so this is the one place the question can be
 * answered; the service asks the rest. A refusal writes nothing and spends
 * nothing. The only thing that goes to the service to ask it is what it already
 * had: the run, the leg and the viewing key. What comes back is the digest of
 * the payments checked, which is all the service is told about the check.
 */
async function refuseALegTheVaultCannotPay(
  doors: RaiseDoors,
  input: { runId: string; viewingKey: string; asset?: string; form?: LedgerForm; vault: string; order?: RaiseOrderOnTheWire },
): Promise<string> {
  const leg = await madeFor(doors).legPayments(input.runId, input.viewingKey, legAsked(input));
  return refusePaymentsTheVaultCannotPay(doors, leg, input);
}

/**
 * **THE CHECK ITSELF, OVER WHATEVER PAYMENTS THE SERVICE HANDED OVER** - a
 * leg's, or a retry's. The digest returned is over exactly what was handed
 * over, in its order.
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
    if (checked !== String(input.order.paymentsChecked)) throw new Error(WRITTEN_DOWN_IS_NOT_WHAT_IS_CHECKED);
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
  }, ['shielded']);
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
  input: { runId: string; viewingKey: string; asset?: string; form?: LedgerForm; vault: string; opensAt: string; closesAt: string },
): Promise<RoundOnThePage> {
  const sent = await raiseLegHere(doors, input);
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
 * PAYS**, read out of each round's sealed payload with the account's viewing
 * key exactly as the company reads them. A round this page holds no payload
 * for, or cannot open, is left out: it covers nobody here, and the company,
 * which opens every round, refuses a retry over its people all the same.
 */
export function roundsOfTheLeg(
  rounds: ReadonlyArray<RoundStanding>, viewingKey: string, runId: string, asset?: string,
): Array<{ readonly id: string; readonly status: string; readonly retry?: readonly number[] }> {
  return rounds.flatMap((r) => {
    if (r.kind === undefined || r.chainId === undefined || r.sealedPayload === undefined) return [];
    let opened: ReturnType<typeof payrollRoundOf>;
    try {
      opened = payrollRoundOf({
        id: r.id, kind: r.kind, status: r.status, chainId: r.chainId as Hex, sealedPayload: r.sealedPayload,
        ...(r.raisedAt ? { raisedAt: r.raisedAt } : {}),
      }, viewingKey as Hex);
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
    runId: string; viewingKey: string; asset?: string; form?: LedgerForm; proposalId: string;
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
  return buildAndSend(doors, order, input.viewingKey, (tx) => service.send(order.proposalId, { tx, version: DEVICE_RAISE_VERSION }));
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
    runId: string; viewingKey: string; asset?: string; form?: LedgerForm; indices: ReadonlyArray<number>;
    vault: string; opensAt: string; closesAt: string;
  },
): Promise<RoundOnThePage> {
  const sent = await raiseRetryHere(doors, input);
  if (sent.raisedAt) return sent;
  return waitFor(doors, 'this retry', sent.id, (r) => Boolean(r.raisedAt), sent);
}

/** What the contract says when this signer has approved this proposal already. */
const ALREADY_APPROVED = 'you have already approved this proposal';

/** Whether a refusal to build an approval is the chain's: this signer approved this proposal already. */
const approvedAlready = (e: unknown): boolean =>
  (e as { name?: unknown } | null)?.name === 'CallNotBuilt' && String((e as Error).message).includes(ALREADY_APPROVED);

/**
 * **ONE APPROVAL, FROM THIS DEVICE.** The approval is built and proved in the
 * worker with this signer's own key material, sent, and the chain asked until
 * it counts one more.
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
 */
export function approveOnDevice(
  doors: GovernedCallDoors, input: { round: RoundOnThePage; viewingKey: string },
): Promise<RoundOnThePage> {
  return approveHere(doors, input, false);
}

/** An approval as `approveOnDevice` builds it; a governance change only from `governOnDevice`, bound to the change it checked. */
async function approveHere(
  doors: GovernedCallDoors,
  input: {
    round: RoundOnThePage; viewingKey: string;
    /** For a governance change: what it changes and its salt, which the approval is refused unless it matches. */
    of?: { governance: GovernanceOnTheWire; proposalSalt: string };
  },
  aChangeCheckedHere: boolean,
): Promise<RoundOnThePage> {
  const { service } = doors;
  const before = await service.standing(input.round.id);
  /* The proposal proved is the one the person was shown, or nothing is built. */
  if (String(before.chainId).toLowerCase() !== String(input.round.chainId).toLowerCase()) {
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
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account,
    order: { circuit: 'approve', proposal: opened.chainId, ...(input.of === undefined ? {} : { of: input.of }) },
    material: doors.material, chain, opened,
  });
  doors.progress?.('sending');
  const sent = await service.approve(input.round.id, { tx });
  const wanted = counted(before) + 1;
  const seen = (r: RoundOnThePage) => counted(r) >= wanted || r.status === 'cancelled';
  const now = seen(sent) ? sent : await waitFor(doors, 'your approval', input.round.id, seen, sent);
  if (now.status === 'cancelled') throw new WithdrawnWhileSent();
  return now;
}

/** A proposal withdrawn while this device's approval of it was on its way: sent, and closed, so nothing is left to do. */
export class WithdrawnWhileSent extends Error {
  readonly nothingWasSent = false;
  constructor() {
    super('this proposal was withdrawn while this approval was being sent. Your approval was sent, and the proposal is closed, '
      + 'so there is nothing more to approve.');
    this.name = 'WithdrawnWhileSent';
  }
}

/**
 * **A PROPOSAL WITHDRAWN FROM THIS DEVICE.** One the chain holds is withdrawn
 * by the call this device proves - a run before its window opens, by any
 * signer; anything else only by the signer who raised it, as the chain checks
 * - and the chain asked until it no longer holds it. One only written down,
 * never sent, is withdrawn with no call.
 */
export async function withdrawOnDevice(
  doors: GovernedCallDoors, input: { round: RoundOnThePage; viewingKey: string },
): Promise<RoundOnThePage> {
  const { service } = doors;
  if (service.cancel === undefined) {
    throw new Error('This page cannot withdraw proposals. Reload the page to get the current version. Nothing was sent.');
  }
  const now = await service.standing(input.round.id);
  if (String(now.chainId).toLowerCase() !== String(input.round.chainId).toLowerCase()) {
    throw new Error('the company now names another proposal than the one shown here. Nothing was built or sent.');
  }
  if (!now.raisedAt) return service.cancel(input.round.id, {});
  const opened = await opensFor(doors)(input.round.id, input.viewingKey, false);
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({
    account: chain.account, order: { circuit: 'cancel', proposal: opened.chainId }, material: doors.material, chain, opened,
  });
  doors.progress?.('sending');
  return service.cancel(input.round.id, { tx });
}

type Api = (path: string, init?: RequestInit) => Promise<any>;

/** A refusal from the service keeps the service's own mark of whether anything was sent. */
const marked = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    throw Object.assign(new Error(message), { nothingWasSent: nothingWasSentBy(e) });
  }
};

/** The service's routes, over this page's own sign-in. No key travels in any of them. */
export const governedCallServiceFor = (api: Api): GovernedCallService => {
  const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const proposal = (id: string) => `/api/proposals/${encodeURIComponent(id)}`;
  const account = (id: string) => `/api/accounts/${encodeURIComponent(id)}`;
  return {
    callState: (accountId) => api(`${account(accountId)}/call-state`),
    send: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/send`, body)),
    approve: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/approve`, body)),
    standing: (proposalId) => post(`${proposal(proposalId)}/standing`, {}),
    cancel: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/cancel`, body)),
    file: (accountId, body) => marked(() => post(`${account(accountId)}/proposals`, body)),
    carry: (proposalId, body) => marked(() => post(`${proposal(proposalId)}/carry`, body)),
    bars: async (accountId) => {
      const status = await api(`${account(accountId)}/ledger`);
      if (status === null || typeof status?.threshold !== 'number') {
        throw new Error('the company\'s account on the chain could not be read, so this device cannot say whether the '
          + 'proposal has the approvals it needs. Nothing was sent.');
      }
      return { threshold: status.threshold, vaultThresholds: Array.isArray(status.vaultThresholds) ? status.vaultThresholds : [] };
    },
    sealedProposals: (accountId) => api(`${account(accountId)}/proposals`),
    sealedAccount: (accountId) => api(account(accountId)),
  };
};

/* ── A GOVERNANCE CHANGE, RAISED, APPROVED AND CARRIED OUT FROM THIS DEVICE ──── */

/** Where a governance change stands after this device has done what it can. */
export type GovernedOutcome =
  | { readonly state: 'done'; readonly round: RoundOnThePage | null }
  | { readonly state: 'waiting-for-approvals'; readonly round: RoundOnThePage };


const sameGovernance = (a: GovernanceOnTheWire, b: GovernanceOnTheWire): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'add-signer') return a.leaf.toLowerCase() === (b as { leaf: string }).leaf.toLowerCase();
  if (a.kind === 'vault-threshold') {
    const o = b as { vault: string; threshold: string };
    return a.vault.toLowerCase() === o.vault.toLowerCase() && BigInt(a.threshold) === BigInt(o.threshold);
  }
  return BigInt(a.threshold) === BigInt((b as { threshold: string }).threshold);
};

/** Each change's kind, as a proposal's sealed record names it. */
const KIND_OF: Readonly<Record<GovernanceOnTheWire['kind'], 'add-signer' | 'set-threshold' | 'set-vault-threshold'>> = {
  'add-signer': 'add-signer', threshold: 'set-threshold', 'vault-threshold': 'set-vault-threshold',
};

/** The circuit that carries each change out. */
const CARRIED_BY: Readonly<Record<GovernanceOnTheWire['kind'], CarryCircuit>> = {
  'add-signer': 'amendSigner', threshold: 'setThreshold', 'vault-threshold': 'setVaultThreshold',
};

/**
 * **THE PROPOSAL THE COMPANY ALREADY HOLDS FOR THIS CHANGE, OPENED HERE**:
 * open, written down with the salt its identity is made with, and for exactly
 * this change. The one the chain holds first, then the newest. Null when there
 * is none, and a new one is written down.
 */
async function liveRoundHere(
  doors: GovernedCallDoors, viewingKey: string, change: GovernanceOnTheWire,
): Promise<{ round: RoundOnThePage; opened: OpenedRound } | null> {
  const { service } = doors;
  if (!service.sealedProposals) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot find this change. Reload the '
      + 'page to get the current version.');
  }
  const candidates = (await service.sealedProposals(doors.accountId))
    .filter((p) => p.accountId === doors.accountId && p.status === 'open')
    .sort((a, b) => (a.raisedAt ? 0 : 1) - (b.raisedAt ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  for (const p of candidates) {
    let opened: OpenedRound;
    try {
      opened = await opensFor(doors)(p.id, viewingKey, false);
    } catch {
      continue;
    }
    if (opened.governance === undefined || !('kind' in opened.governance)) continue;
    if (!sameGovernance(opened.governance as GovernanceOnTheWire, change)) continue;
    return { round: { id: p.id, chainId: p.chainId, status: p.status, approvalCount: p.approvalCount,
      ...(p.txRef === undefined ? {} : { txRef: p.txRef }), ...(p.raisedAt === undefined ? {} : { raisedAt: p.raisedAt }) }, opened };
  }
  return null;
}

/**
 * A proposal's raise half for a governance change: no asset, nothing moved, the
 * salt its identity is made with, and the account's asset blinding from the
 * company state its founding seat signed, which the raise commits its change with.
 */
/** The account's own name for no asset, which a governance proposal's raise names: nothing moves. */
const NO_ASSET_NAMED = { assetId: assetIdBytes(NO_ASSET) };

const governanceHalf = (salt: string, opened: OpenedRound, assetBlinding: string) => ({
  assetId: opened.half?.assetId ?? hexOfBytes(NO_ASSET_NAMED.assetId),
  assetBlinding,
  proposalSalt: salt,
  changeAmount: opened.half?.changeAmount ?? '0',
  changeBatchDigest: opened.half?.changeBatchDigest ?? commit('', ''),
});

/** Whether the chain's count for a governance proposal meets the account's own threshold, as the chain holds it. */
const meetsTheBar = async (doors: GovernedCallDoors, round: RoundOnThePage): Promise<boolean> => {
  if (!doors.service.bars) return false;
  const bars = await doors.service.bars(doors.accountId);
  return counted(round) >= bars.threshold;
};

/**
 * **A GOVERNANCE CHANGE TAKEN AS FAR AS THIS DEVICE CAN TAKE IT.** The
 * proposal the company already holds for it is used; with none, one is written
 * down here - sealed under the company's viewing key and signed by this seat -
 * and raised. It is approved by this signer if they have not approved it, and
 * carried out once the chain counts the approvals it needs. A proposal still
 * short of approvals is left for the others to approve from their own devices,
 * and said so. `before` is the check this device makes before it approves or
 * carries out the change; it refuses by throwing.
 */
async function governOnDevice(
  doors: GovernanceDoors,
  input: {
    viewingKey: string; change: GovernanceOnTheWire; summary: string; body: GovernancePayloadBody;
    before?: () => Promise<void>;
  },
): Promise<GovernedOutcome> {
  const { service } = doors;
  /*
   * **NO CHANGE THIS DEVICE RAISES, APPROVES OR CARRIES OUT LEAVES A VAULT
   * UNABLE TO PAY**: counted afresh before each, over the company as it stands
   * then, as well as any check the caller makes.
   */
  const check = async (): Promise<void> => {
    refuseLeavingAVaultShort(await doors.approvers(), changeCounted(input.change), doors.vaultName);
    await input.before?.();
  };
  const key = input.viewingKey as Hex;
  if (doors.records === undefined) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot raise or carry out this '
      + 'change. Reload the page to get the current version.');
  }
  const records = doors.records;
  const blinding = async (): Promise<string> => (await signedStateHere(records, doors.accountId, key)).assetBlinding;
  let live = await liveRoundHere(doors, input.viewingKey, input.change);
  if (live === null) {
    if (!service.file) throw new Error('This page cannot write proposals down. Reload the page to get the current version. Nothing was sent.');
    await check();
    const salt = doors.filing.salt();
    if (doors.builder.proposalIdentity === undefined) {
      throw new Error('This page cannot work out a proposal\'s identity. Reload the page to get the current version. Nothing was sent.');
    }
    const identity = await doors.builder.proposalIdentity(input.change, salt);
    const change = { asset: NO_ASSET, amount: 0n, batchDigest: commit('', ''), salt: salt as Hex };
    const filing = signProposalFiling(doors.accountId, {
      id: doors.filing.newId(), digest: identity.digest as Hex, chainId: identity.chainId as Hex, keyEpoch: doors.filing.keyEpoch,
      createdAt: new Date().toISOString(),
      sealed: sealGovernanceProposal({
        accountId: doors.accountId, viewingKey: key, kind: KIND_OF[input.change.kind], summary: input.summary,
        noVault: identity.noVault as Hex, body: input.body, change, proposedBy: doors.filing.seat,
      }),
    }, doors.material.signingSecret as Hex);
    const opened: OpenedRound = {
      chainId: identity.chainId, digest: identity.digest, vault: identity.noVault, salt, summary: input.summary,
      governance: input.change, half: { assetId: hexOfBytes(NO_ASSET_NAMED.assetId), changeAmount: '0', changeBatchDigest: change.batchDigest },
    };
    doors.progress?.('reading-the-chain');
    const chain = await service.callState(doors.accountId);
    doors.progress?.('building');
    const { tx } = await doors.builder.governedCall({
      account: chain.account, material: doors.material, chain, opened,
      order: { circuit: 'propose', governance: input.change, half: governanceHalf(salt, opened, await blinding()), proposal: identity.chainId },
    });
    doors.progress?.('sending');
    const sent = await service.file(doors.accountId, { proposal: filing, tx, version: DEVICE_RAISE_VERSION, salt });
    const round = sent.raisedAt ? sent : await waitFor(doors, 'this proposal', filing.id, (r) => Boolean(r.raisedAt), sent);
    live = { round, opened };
  } else if (!live.round.raisedAt) {
    const { round, opened } = live;
    doors.progress?.('reading-the-chain');
    const chain = await service.callState(doors.accountId);
    doors.progress?.('building');
    const { tx } = await doors.builder.governedCall({
      account: chain.account, material: doors.material, chain, opened,
      order: { circuit: 'propose', governance: input.change, half: governanceHalf(opened.salt, opened, await blinding()), proposal: opened.chainId },
    });
    doors.progress?.('sending');
    const sent = await service.send(round.id, { tx, version: DEVICE_RAISE_VERSION });
    live = { round: sent.raisedAt ? sent : await waitFor(doors, 'this proposal', round.id, (r) => Boolean(r.raisedAt), sent), opened };
  }
  let { round } = live;
  const { opened } = live;
  const of = { governance: input.change, proposalSalt: opened.salt };
  if (!(await meetsTheBar(doors, round))) {
    await check();
    try {
      round = await approveHere(doors, { round, viewingKey: input.viewingKey, of }, true);
    } catch (e) {
      if (!approvedAlready(e)) throw e;
      round = await service.standing(round.id);
    }
  }
  if (!(await meetsTheBar(doors, round))) return { state: 'waiting-for-approvals', round };
  if (!service.carry) throw new Error('This page cannot carry out proposals. Reload the page to get the current version. Nothing was sent.');
  await check();
  /* What carries it out is made here, from the proposal as this device opened it. */
  const order = carryOrderHere(opened);
  const carried = order as { circuit?: string; proposal?: string };
  if (carried.circuit !== CARRIED_BY[input.change.kind] || String(carried.proposal).toLowerCase() !== String(round.chainId).toLowerCase()) {
    throw new Error('the company\'s record of this proposal is not the change asked for here. Nothing was built or sent. '
      + 'Reload the page and try again.');
  }
  doors.progress?.('reading-the-chain');
  const chain = await service.callState(doors.accountId);
  doors.progress?.('building');
  const { tx } = await doors.builder.governedCall({ account: chain.account, order, material: doors.material, chain, opened });
  doors.progress?.('sending');
  const done = await service.carry(round.id, { tx, circuit: CARRIED_BY[input.change.kind] });
  return { state: 'done', round: done };
}

/** What writing a governance proposal down needs of this device: its seat, the company's key epoch, and fresh names. */
interface GovernanceFilingDoors {
  /** This device's seat on the company, as its directory entry names it. */
  readonly seat: string;
  readonly keyEpoch: number;
  readonly salt: () => string;
  readonly newId: () => string;
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
};

/** A governance change, as the vault check counts it. A seat is given every right, as every seat is made today. */
const changeCounted = (change: GovernanceOnTheWire): VaultCheckChange => {
  if (change.kind === 'add-signer') return { kind: 'seat', leaf: change.leaf.toLowerCase() as Hex, rights: EVERY_RIGHT };
  if (change.kind === 'threshold') return { kind: 'threshold', threshold: Number(change.threshold) };
  return { kind: 'vaultThreshold', vault: change.vault.toLowerCase() as Hex, threshold: Number(change.threshold) };
};

/** Changes the account's threshold, as far as this device can: see `governOnDevice`. */
export function changeThresholdOnDevice(
  doors: GovernanceDoors, input: { viewingKey: string; newThreshold: number; seated: number },
): Promise<GovernedOutcome> {
  if (!Number.isInteger(input.newThreshold) || input.newThreshold < 1) {
    return Promise.reject(new Error('the threshold must be a whole number, at least one. Nothing was sent.'));
  }
  return governOnDevice(doors, {
    viewingKey: input.viewingKey,
    change: { kind: 'threshold', threshold: String(input.newThreshold) },
    summary: `Change the approval threshold to ${input.newThreshold} of ${input.seated}`,
    body: { newThreshold: input.newThreshold },
  });
}

/**
 * **ONE VAULT'S OWN APPROVALS NEEDED, CHANGED AS FAR AS THIS DEVICE CAN.** The
 * proposal names the vault and the number; `before` is the check every signer's
 * device makes before it approves or carries it out.
 */
export function changeVaultThresholdOnDevice(
  doors: GovernanceDoors,
  input: { viewingKey: string; vault: string; newThreshold: number; seated: number; before?: () => Promise<void> },
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
    ...(input.before === undefined ? {} : { before: input.before }),
  });
}

export { governOnDevice };

/**
 * **ONE PERSON WAITING FOR A SEAT, SEATED AND ADMITTED AS FAR AS THIS DEVICE
 * CAN.** Who waits is read from the company's inbox and checked here before
 * anything is raised, approved, carried out or filed (`waitingHere`): their
 * keys against the proof their invitation gave them, against every other
 * signer's, against the fingerprint they read out (`readOut`), and against the
 * sign-in their request was sealed for. The seat is then a governance change
 * like any other; once the chain holds it, they are admitted to the roster
 * from this device and the company's key is wrapped to them.
 */
export async function seatSignerOnDevice(
  doors: GovernanceDoors & { readonly roster: RosterDoors },
  input: { viewingKey: string; signerId: string; readOut: string },
): Promise<GovernedOutcome> {
  const look = async () => {
    const { sealed, account } = await rosterHere(doors.roster);
    return waitingHere(sealed, account, doors.roster.viewingKey, input.signerId, input.readOut);
  };
  const { payload } = await look();
  const leaf = payload.leafCommitment.toLowerCase();
  /* A seat the chain already holds, from a carrying out that stopped before the admission, is only admitted. */
  const held = doors.records === undefined ? false : (await doors.records.directory()).holders.seats.includes(leaf);
  const outcome: GovernedOutcome = held ? { state: 'done', round: null } : await governOnDevice(doors, {
    viewingKey: input.viewingKey,
    change: { kind: 'add-signer', leaf },
    summary: `Add ${payload.name} as a signer`,
    body: { signerId: input.signerId },
    before: async () => { await look(); },
  });
  if (outcome.state !== 'done') return outcome;
  await admitSignerHere(doors.roster, { signerId: input.signerId, readOut: input.readOut });
  return outcome;
}

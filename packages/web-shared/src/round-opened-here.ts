/**
 * **ONE PROPOSAL, READ ON THIS DEVICE FROM THE COMPANY'S OWN RECORDS, BEFORE
 * ANYTHING IS BUILT FROM IT.**
 *
 * The one way a proposal is opened where it is raised again, approved or
 * carried out: what the call is checked against and proved with comes from
 * here and from nowhere else, so nothing wired to raise or approve can hand a
 * device a proposal it did not open itself.
 */
import { keyOf, type KeysHeld } from '../../../src/core/company-key.js';
import { parseCanonical, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { paymentChecked } from '../../../src/core/device-raise.js';
import { openRecord } from '../../../src/core/sealed-records.js';
import { openAccount } from '../../../src/core/account.js';
import { refuseASeatKeyNotFromTheInvitee, SeatKeyNotFromTheInvitee } from '../../../src/core/seat-invite-proof.js';
import { answerOpenedWith } from '../../../src/core/answer-opened.js';
import { assetIdBytes, NO_ASSET } from '../../../src/core/assets.js';
import type { PendingSignerPayload, SealedAccount } from '../../../src/core/types.js';
import type { StateChange } from '../../../src/core/ledger.js';
import { paysCommitmentOf, proposalFilingRefusal, VAULT_START_KINDS, type RetirementTerms } from '../../../src/core/proposal-filing.js';
import { companyRecordKey, FILING_REFUSAL, notOnTheChainNow } from '../../../src/midnight/seat-directory.js';
import { proposalEntry } from '../../../src/midnight/record-manifest.js';
import { vouchedRefusal } from '../../../src/midnight/record-tree.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { GovernanceOnTheWire, OpenedRound } from './governed-call-builder.js';
import type { GovernedCallService } from './governed-call-on-device.js';
import { judgeIn, kindAsked, listedHere, refusedForItsKey } from './vault-page-doors.js';
import { NO_ROSTER_RECORD, provedSeatsOf, refuseASeatNotForTheInvited, type SeatingReads } from './roster-here.js';
import { runRebuiltHere, signedStateHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import { RoundRefusedHere, refuseWhatNoRoundMay } from './raise-checks-here.js';
import { oneOffMadeHere, OneOffRefused } from './one-off-here.js';

/**
 * The company's records a proposal is read against: its directory and where its proposals stand on the chain always,
 * and the rest only where a payroll run is made again from them.
 */
export type RecordsForTheRound = Pick<CompanyRecordsHere, 'directory'> & Partial<CompanyRecordsHere>;

const wholeRecords = (records: RecordsForTheRound): records is CompanyRecordsHere => typeof records.runs === 'function';

const HEX64 = /^[0-9a-f]{64}$/u;
const hexOfBytes = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Why this device could not read the company's record of a proposal itself. Nothing is built without it. */
export class NotOpenedOnThisDevice extends Error {
  /** The kind its sealed record names, where it was opened far enough to read one before it was refused. */
  readonly kind?: string;
  /**
   * Set when the one thing refused is that the seat that filed it has left the company and filed it past what its
   * retirement kept: no device will ever act on it, and the chain no longer seats the one who filed it.
   */
  readonly passedOver?: true;
  constructor(why: string, options?: { cause?: unknown; kind?: string; passedOver?: true }) {
    super(`${why} Nothing was built or sent.`, options);
    this.name = 'NotOpenedOnThisDevice';
    if (options?.kind !== undefined) this.kind = options.kind;
    if (options?.passedOver === true) this.passedOver = true;
  }
}

/**
 * **WHO FILED A PROPOSAL, AS THIS DEVICE BELIEVES IT**: the filing key of its
 * signed filing, when the signature covers exactly it and the company's
 * records anchor it under that seat (`judgeIn`); null for one that carries no
 * signed filing. A filing that does not check is refused, saying so.
 */
export async function believedFilerHere(
  records: RecordsForTheRound, accountId: string, rec: { readonly id: string; readonly keyEpoch: number; readonly filedBy?: { readonly publicKey: string } },
): Promise<string | null> {
  if (rec.filedBy === undefined) return null;
  let here: Awaited<ReturnType<RecordsForTheRound['directory']>> | null = null;
  let why = proposalFilingRefusal(accountId, rec);
  if (why === null) {
    here = await records.directory({ records: [{ store: 'proposal', kind: 'proposal', id: rec.id }] });
    why = judgeIn(here)(
      rec.filedBy.publicKey as Hex, 'proposal', companyRecordKey('proposal', rec.id), proposalEntry(accountId, rec as never), true, rec.keyEpoch);
  }
  if (why !== null) {
    const filer = rec.filedBy.publicKey.toLowerCase();
    const seat = here?.dir.seats.find((x) => x.signingKey === filer);
    const passedOver = why === FILING_REFUSAL['past-its-boundary'] && seat !== undefined && seat.retired !== null
      && notOnTheChainNow(seat, here!.holders) !== null;
    throw new NotOpenedOnThisDevice(`This device does not believe the company's record of this proposal (${why}). Do not `
      + 'act on it.', passedOver ? { passedOver: true } : undefined);
  }
  return rec.filedBy.publicKey.toLowerCase();
}

/** Kinds a device here acts on. Any other is refused before anything is read out of it. */
const KINDS_A_DEVICE_ACTS_ON = new Set(['payroll', 'transfer', 'add-signer', 'remove-signer', 'set-threshold', 'set-vault-threshold', 'set-spending-policy', 'set-policy-bar']);

/**
 * A removal's retirement terms as its proposal seals them, in their shape, or null: a record of the last versions
 * the leaving seat filed, its statement where one is carried, and a whole number of approvals. Whether a device would
 * sign them is its own to judge (`removalRefusalHere`).
 */
const retirementTermsOf = (x: unknown): RetirementTerms | null => {
  const t = x as Partial<RetirementTerms> | null;
  if (t === null || typeof t !== 'object' || typeof t.filedUpTo !== 'object' || t.filedUpTo === null
    || !Object.values(t.filedUpTo).every((v) => Number.isSafeInteger(v) && v >= 0)
    || !Number.isSafeInteger(t.threshold) || (t.threshold as number) < 1
    || (t.atHead !== undefined && (typeof t.atHead !== 'string' || !/^[0-9a-f]{64}$/u.test(t.atHead)))) return null;
  const st = t.statement;
  if (st !== undefined && (st === null || typeof st !== 'object' || typeof st.recordsKey !== 'string' || typeof st.seat !== 'string'
    || typeof st.signature !== 'string')) return null;
  return {
    filedUpTo: { ...t.filedUpTo }, threshold: t.threshold as number, ...(t.atHead === undefined ? {} : { atHead: t.atHead }),
    ...(st === undefined ? {} : { statement: { recordsKey: st.recordsKey, seat: st.seat, signature: st.signature } }),
  };
};

/**
 * **ONE PROPOSAL, READ ON THIS DEVICE FROM THE COMPANY'S OWN RECORDS.**
 *
 * The proposal's record is opened with the company's key of the epoch it was
 * sealed at, and the payload sealed inside it with the same key: that is where the salt its
 * identity was made with is kept, what a seat or a threshold change changes,
 * and, for a raise, the change the proposal commits to. The leaf of a person to
 * be seated is read from the company's roster, opened here too. What is
 * returned is what the call is checked against and proved with
 * (`refuseWhatThisDeviceDidNotOpen`).
 *
 * **THE LIMITS, SAID PLAINLY.** Every one of these records is sealed under a
 * key every signer of its epoch holds, so a signer who rewrote a record whole
 * and sealed it again would be read here as written; the service holds no such
 * key and sees only sealed bytes. The identity
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
 * each of them are read from the run's sealed record as the service stored it,
 * opened here, never from anything the service says in the clear.
 */
export async function openTheRoundHere(
  service: GovernedCallService, accountId: string, proposalId: string, viewingKey: KeysHeld, forARaise: boolean,
  records?: RecordsForTheRound,
  /** The leaf each opening makes, in this device's vault worker: a seat's leaf is approved here only as its opening makes it. */
  leaves?: SeatingReads['leaves'],
): Promise<OpenedRound> {
  if (!service.sealedProposals) {
    throw new NotOpenedOnThisDevice('This page cannot read the company\'s records, so it cannot check this proposal. Reload '
      + 'the page to get the current version.');
  }
  /* A proposal the company's records name and the service leaves out of its list is withheld, not withdrawn (`listedHere`). */
  const served = await service.sealedProposals(accountId);
  const listed = records === undefined ? served : listedHere(await records.directory(kindAsked('proposal')), 'proposal', served, 'proposal');
  const rec = listed.find((r) => r.id === proposalId);
  if (rec === undefined && records !== undefined) refusedForItsKey(listed as { leftOut?: ReadonlyMap<string, string> }, proposalId, 'proposal');
  if (!rec || rec.accountId !== accountId) {
    throw new NotOpenedOnThisDevice('This company\'s records hold no proposal by that name. It may have been withdrawn. '
      + 'Reload the page to see where it stands.');
  }
  let envelope: { kind: string; summary: string; vault: string; sealedPayload: Sealed };
  let body: {
    signerId?: unknown; newThreshold?: unknown; vault?: unknown; assetKey?: unknown; commitment?: unknown; newPolicyBar?: unknown;
    leaf?: unknown; retirement?: unknown; oneOff?: unknown;
    __change?: StateChange;
  };
  let key: Hex;
  try {
    key = keyOf(viewingKey, rec.keyEpoch);
    envelope = openRecord('proposals', rec.accountId, rec.sealed, key);
    if (VAULT_START_KINDS.includes(envelope.kind)) {
      throw new NotOpenedOnThisDevice('This proposal sets up one of the company\'s vaults, and it is raised and approved only '
        + 'from setting that vault up, where who its secret is sealed to is checked. Leave it unapproved here, and open the '
        + 'vault to finish setting it up.', { kind: envelope.kind });
    }
    if (!KINDS_A_DEVICE_ACTS_ON.has(envelope.kind)) {
      throw new NotOpenedOnThisDevice('This page acts on payroll runs, one-off payments from a vault, access for new signers, removing '
        + 'a signer, changes to the approvals required by the company or by one of its vaults, and vaults\' spending policies, and this '
        + 'proposal is none of those, so it cannot be approved from this device yet. Leave it unapproved.', { kind: envelope.kind });
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
      + 'open the vault to finish setting it up.', { kind: envelope.kind });
  }
  let governance: GovernanceOnTheWire | undefined;
  let retirement: RetirementTerms | undefined;
  if (envelope.kind === 'remove-signer') {
    /* The leaf is the proposal's own, sealed inside it; who it is and whether to remove it is judged where the removal is made. */
    if (typeof body.leaf !== 'string' || !HEX64.test(body.leaf.toLowerCase())) {
      throw new NotOpenedOnThisDevice('This proposal does not say which signer it removes. Withdraw it and raise the removal again.');
    }
    if (body.retirement !== undefined) {
      const terms = retirementTermsOf(body.retirement);
      if (terms === null) {
        throw new NotOpenedOnThisDevice('This proposal\'s retirement of the leaving signer is not in its shape, so this device '
          + 'cannot sign it. Withdraw it and raise the removal again.');
      }
      retirement = terms;
    }
    governance = { kind: 'remove-signer', leaf: body.leaf.toLowerCase() };
  } else if (envelope.kind === 'add-signer') {
    if (!service.sealedAccount) {
      throw new NotOpenedOnThisDevice('This page cannot read the company\'s list of signers, so it cannot check this '
        + 'proposal. Reload the page to get the current version.');
    }
    let leaf: string | null | undefined;
    try {
      const sealedAccount = await service.sealedAccount(accountId) as SealedAccount & { roster?: SealedCompanyRecord | null };
      /* The signers are read only from the company's roster record, never from a list on its account record. */
      if ((sealedAccount.roster ?? null) === null) throw new NotOpenedOnThisDevice(NO_ROSTER_RECORD);
      const signers = openAccount(sealedAccount, viewingKey, sealedAccount.roster).signers;
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
       * which this device works out again from the key whose inbox opened the
       * request (one sealed to an inbox from before the company's key changed
       * is believed only when that change named it), and only for
       * the person a seat this device believes invited, at a leaf their
       * opening makes for their wallet. A key put there by somebody without
       * that key carries no proof that passes, and is refused here, before
       * anything is built or approved.
       */
      if (named?.status === 'pending') {
        const box = sealedAccount.pendingSigners.find((p) => p.id === named.id);
        if (!box) {
          throw new SeatKeyNotFromTheInvitee('This person\'s acceptance could not be found. Access was not granted and '
            + 'nothing was sent. Reload the page; if they are still shown as waiting, press Grant access again.');
        }
        let opened: { readonly value: PendingSignerPayload; readonly key: Hex };
        try {
          opened = answerOpenedWith<PendingSignerPayload>(viewingKey, box.sealed, accountId);
        } catch (e) {
          throw new SeatKeyNotFromTheInvitee((e as Error)?.message ?? String(e));
        }
        const waiting = opened.value;
        refuseASeatKeyNotFromTheInvitee(opened.key, accountId, waiting);
        /* The person invited, by a seat this device believes, and a leaf made for their wallet: checked again on every open. */
        if (records === undefined || leaves === undefined) {
          throw new NotOpenedOnThisDevice('This page cannot check who this seat is for, or that its keys are made for their '
            + 'wallet, so it cannot act on it. Reload the page to get the current version.');
        }
        const believed = await records.directory();
        await refuseASeatNotForTheInvited(sealedAccount, viewingKey, box, waiting, {
          seats: provedSeatsOf(believed.dir.seats), onTheChain: believed.holders.seats, leaves,
        });
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
  } else if (envelope.kind === 'set-spending-policy') {
    if (![body.vault, body.assetKey, body.commitment].every((v) => typeof v === 'string' && HEX64.test(v))) {
      throw new NotOpenedOnThisDevice('This proposal does not say which vault and currency its spending policy is for, or '
        + 'which policy. Withdraw it and set the policy again.');
    }
    governance = { kind: 'spending-policy', vault: body.vault as string, assetKey: body.assetKey as string, commitment: body.commitment as string };
  } else if (envelope.kind === 'set-policy-bar') {
    if (typeof body.newPolicyBar !== 'number' || !Number.isInteger(body.newPolicyBar) || body.newPolicyBar < 1) {
      throw new NotOpenedOnThisDevice('This proposal does not say how many approvals a change to a spending policy would '
        + 'need. Withdraw it and make the change again.');
    }
    governance = { kind: 'policy-bar', bar: String(body.newPolicyBar) };
  }
  /*
   * **A PROPOSAL A SEAT'S DEVICE WROTE DOWN IS BELIEVED ONLY AS THAT SEAT FILED
   * IT**: its filing signed by a key this device's own read of the company's
   * directory holds for a seat whose role may raise proposals, which the
   * opened proposal names (`OpenedRound.filedBy`). One the service wrote down
   * itself carries no filing, is read as before and names no filer, so it is
   * refused wherever who raised it must be known (`refuseWhatALeaverFiledHere`).
   */
  let filedBy: string | null = null;
  if (rec.filedBy !== undefined) {
    if (records === undefined) {
      throw new NotOpenedOnThisDevice('This page cannot read the company\'s directory, so it cannot check who wrote this '
        + 'proposal down. Reload the page to get the current version.');
    }
    filedBy = await believedFilerHere(records, accountId, rec);
  }
  /*
   * **A PAYROLL RUN, OR A ONE-OFF PAYMENT, IS APPROVED ONLY AS THIS DEVICE
   * READS IT FROM THE COMPANY'S RECORDS**, and made again from them where the
   * approval is built.
   */
  let made: OpenedRound['made'];
  if (envelope.kind === 'payroll') {
    if (records === undefined || !wholeRecords(records)) {
      throw new NotOpenedOnThisDevice('This page cannot read the company\'s records a payroll run is checked against, so it '
        + `cannot ${forARaise ? 'raise' : 'approve'} one. Reload the page to get the current version.`);
    }
    const rebuilt = await runRebuiltHere(records, accountId, rec.id, viewingKey);
    made = rebuilt.made;
    /*
     * **WHAT THE FILING SAID IT PAYS IS WHAT THIS DEVICE WOULD PAY**: the
     * commitment its filer signed, keyed with the proposal's salt and the
     * company's asset blinding, is to the vault the proposal names and to the
     * payments of the run as built again here from the company's sealed records.
     */
    if (rec.filedBy !== undefined) {
      const paying = rebuilt.made.retry === undefined ? rebuilt.made.facts : rebuilt.made.retry.map((i) => rebuilt.made.facts[i]!);
      const { assetBlinding } = await signedStateHere(records, accountId, viewingKey);
      const pays = paysCommitmentOf({ vault: envelope.vault, asset: String(change.asset), payments: paying.map(paymentChecked) }, change.salt, assetBlinding);
      if (String(rec.pays ?? '').toLowerCase() !== pays) {
        throw new NotOpenedOnThisDevice('What the company\'s record of this proposal says it pays is not what this device '
          + 'builds the run to pay, from the vault it names. Do not act on it.');
      }
    }
    /*
     * **AND EVERY CHECK THE RAISING DEVICE RAN, RUN AGAIN HERE** on what this
     * device reads now, by its own clock, for a send and an approval alike: the
     * one list of raise checks, judged for the seat that filed the proposal, and
     * never refusing the proposal for being itself.
     */
    try {
      await refuseWhatNoRoundMay(records, accountId, viewingKey, {
        run: rebuilt.run, leg: rebuilt.leg, made: rebuilt.made, filedBy: rec.filedBy?.publicKey ?? '', proposal: rec.id,
        vault: envelope.vault,
      });
    } catch (e) {
      if (!(e instanceof RoundRefusedHere)) throw e;
      throw new NotOpenedOnThisDevice(`${e.message}. Do not ${forARaise ? 'send' : 'approve'} it, and tell the person who `
        + 'raised it.', { cause: e });
    }
  } else if (envelope.kind === 'transfer') {
    /* A one-off payment: made again from the record it names, which must name this proposal, its vault, its currency and its filer. */
    if (records === undefined || filedBy === null) {
      throw new NotOpenedOnThisDevice('This page cannot check who raised this one-off payment against the company\'s records, so it '
        + `cannot ${forARaise ? 'raise' : 'approve'} it. Reload the page to get the current version.`);
    }
    try {
      made = await oneOffMadeHere(records as Pick<CompanyRecordsHere, 'directory' | 'oneOffs' | 'payments'>, accountId,
        { id: rec.id, chainId: rec.chainId, filedBy }, { vault: envelope.vault, named: body.oneOff, asset: String(change.asset) });
    } catch (e) {
      if (!(e instanceof OneOffRefused)) throw e;
      throw new NotOpenedOnThisDevice(`${e.message} Do not ${forARaise ? 'send' : 'approve'} it, and tell the person who raised it.`, { cause: e });
    }
  }
  /*
   * **WHAT A PAYROLL RUN'S SALT WAS MADE FROM**, as its proposal seals it, and
   * whether this device checked that head itself: its own database of the heads
   * it checked is asked, never the service. A proposal sealing none is left
   * without, and the approval refuses it (`refuseWhatThisDeviceDidNotMake`).
   */
  let vouched: OpenedRound['vouched'];
  if (envelope.kind === 'payroll' && vouchedRefusal(change.vouched) === null) {
    const head = change.vouched!.head.toLowerCase();
    const kept = await records?.checked?.() ?? null;
    vouched = { head: head as Hex, r: change.vouched!.r.toLowerCase() as Hex, checkedHere: kept !== null && kept.heads.some((h) => h.toLowerCase() === head) };
  }
  let half: OpenedRound['half'];
  if (forARaise) {
    /* The account's own name for the asset, which is what the asset witness answers with. */
    const named = { assetId: assetIdBytes(change.asset) };
    half = { assetId: hexOfBytes(named.assetId), changeAmount: String(change.amount), changeBatchDigest: change.batchDigest };
  }
  return {
    chainId: rec.chainId, digest: rec.digest, vault: envelope.vault, salt: change.salt, summary: envelope.summary,
    ...(vouched === undefined ? {} : { vouched }),
    ...(governance === undefined ? {} : { governance }), ...(half === undefined ? {} : { half }),
    ...(retirement === undefined ? {} : { retirement }),
    ...(made === undefined ? {} : { made }), ...(filedBy === null ? {} : { filedBy }),
  };
}


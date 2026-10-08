/**
 * **ONE PROPOSAL, READ ON THIS DEVICE FROM THE COMPANY'S OWN RECORDS, BEFORE
 * ANYTHING IS BUILT FROM IT.**
 *
 * The one way a proposal is opened where it is raised again, approved or
 * carried out: what the call is checked against and proved with comes from
 * here and from nowhere else, so nothing wired to raise or approve can hand a
 * device a proposal it did not open itself.
 */
import { parseCanonical, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { paymentChecked } from '../../../src/core/device-raise.js';
import { openFromInbox, openRecord } from '../../../src/core/sealed-records.js';
import { openAccount } from '../../../src/core/account.js';
import { refuseASeatKeyNotFromTheInvitee, SeatKeyNotFromTheInvitee } from '../../../src/core/seat-invite-proof.js';
import { assetIdBytes, NO_ASSET } from '../../../src/core/assets.js';
import type { PendingSignerPayload, SealedAccount } from '../../../src/core/types.js';
import type { StateChange } from '../../../src/core/ledger.js';
import { paysCommitmentOf, proposalFilingRefusal } from '../../../src/core/proposal-filing.js';
import { companyRecordKey } from '../../../src/midnight/seat-directory.js';
import type { SealedCompanyRecord } from '../../../src/midnight/sealed-record-wire.js';
import type { GovernanceOnTheWire, OpenedRound } from './governed-call-builder.js';
import type { GovernedCallService } from './governed-call-on-device.js';
import { judgeIn } from './vault-page-doors.js';
import { NO_ROSTER_RECORD } from './roster-here.js';
import { runRebuiltHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import { RoundRefusedHere, refuseWhatNoRoundMay } from './raise-checks-here.js';

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
    made = rebuilt.made;
    /*
     * **WHAT THE FILING SAID IT PAYS IS WHAT THIS DEVICE WOULD PAY**: the vault
     * the service checked is the proposal's, and the payments are the run's as
     * built again here, so a raise cannot pass the vault's public money check on
     * payments other than its own.
     */
    if (rec.filedBy !== undefined) {
      const paying = rebuilt.made.retry === undefined ? rebuilt.made.facts : rebuilt.made.retry.map((i) => rebuilt.made.facts[i]!);
      const pays = paysCommitmentOf({ vault: envelope.vault, asset: String(change.asset), payments: paying.map(paymentChecked) }, change.salt);
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
      await refuseWhatNoRoundMay(records, accountId, key, {
        run: rebuilt.run, leg: rebuilt.leg, made: rebuilt.made, filedBy: rec.filedBy?.publicKey ?? '', proposal: rec.id,
      });
    } catch (e) {
      if (!(e instanceof RoundRefusedHere)) throw e;
      throw new NotOpenedOnThisDevice(`${e.message}. Do not ${forARaise ? 'send' : 'approve'} it, and tell the person who `
        + 'raised it.', { cause: e });
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


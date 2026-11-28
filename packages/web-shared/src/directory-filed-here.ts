/**
 * **A SIGNER'S OWN ENTRY IN THE COMPANY'S SEAT DIRECTORY, AS THIS DEVICE FILES IT**: read and filed through the step's
 * view of the company once this device can seal it and read the invitation behind its seat. It files nothing it cannot sign, and a refusal leaves
 * the entry owed and says why. Nothing filed here is believed until the directory is read again and replayed.
 */
import { keyInForce, type KeysHeld } from '../../../src/core/company-key.js';
import type { Hex } from '../../../src/core/crypto.js';
import { keysByPurpose } from './keys-by-purpose.js';
import type { SealedProposal } from '../../../src/core/types.js';
import {
  directoryEntryMade,
  type CommitteeKey,
  type DirectoryEntry,
  type DirectoryFiling
} from '../../../src/midnight/seat-directory.js';
import type { DirectoryEntryStatement } from 'midnight-identity/profile/records-key';
import type { OwedDirectoryEntry } from './keyring-blob.js';
import { openSeatProof, type SeatOpening } from '../../../src/core/seat-opening.js';
import type { SignedSeatInvitation } from '../../../src/core/invitation.js';
import { seatInvitationIn } from '../../../src/core/proposal-filing.js';
import type { CompanyView } from './company-view.js';

/**
 * **THIS SIGNER'S OWN ENTRY IN THE COMPANY'S SEAT DIRECTORY, FILED FROM THIS
 * DEVICE** with the statement their wallet signed in the same press as their
 * records key, its wallet key, signature, opening and the invitation a seat
 * signed for them (`invited`) sealed under the company's roster key, and the
 * whole signed by this seat's filing key (`directoryEntryMade`). Filed as the
 * next version; an entry already there for this seat with these keys is left
 * alone, so it can run on every press, unless it carries another invitation
 * than the one this device now holds, or none.
 */
/** The view a seat's own entry is read and filed through: the step's current one. */
export interface EntryView {
  current(): Pick<CompanyView<unknown>, 'filings' | 'list' | 'write'>;
}

/** What filing an owed entry reads and writes, through the step's view: the directory, the proposals and the one filing. */
interface EntryService {
  filings(): Promise<readonly DirectoryFiling[]>;
  proposals(): Promise<unknown>;
  file(filing: DirectoryFiling): Promise<void>;
}

const entryServiceOf = (view: EntryView): EntryService => ({
  filings: () => view.current().filings(),
  proposals: () => view.current().list('proposals'),
  file: async (filing) => {
    await view.current().write([{ to: 'directory', filing }]);
  }
});

const fileOwnDirectoryEntry = async (
  service: EntryService,
  accountId: string,
  person: string,
  signed: { readonly committeeKey: CommitteeKey; readonly entry: DirectoryEntryStatement },
  opening: SeatOpening,
  keys: { readonly signingSecret: Hex; readonly viewingKey: KeysHeld },
  invited: SignedSeatInvitation | null
): Promise<'filed' | 'already-there'> => {
  const filings = await service.filings();
  /*
   * Already filed for this seat with these keys, and carrying the very invitation this device holds: an entry filed
   * under one whose inviter has left since is filed again under the one re-issued for it.
   */
  const there = filings.some(
    (f) =>
      f?.change?.kind === 'claim' &&
      f.change.entry?.statement?.seat === signed.entry.seat &&
      f.change.entry.statement.signingKey === signed.entry.signingKey &&
      f.change.entry.statement.wrappingKey === signed.entry.wrappingKey &&
      (invited === null ||
        ((proof) =>
          keysByPurpose(keys.viewingKey)
            .everyEpoch()
            .some((k) => openSeatProof(accountId, proof, k)?.invited?.signature === invited.signature))(
          f.change.entry.proof
        ))
  );
  if (there) return 'already-there';
  const entry: DirectoryEntry = directoryEntryMade({
    /*
     * Sealed under the key in force even while sealing is paused: the change of the key that ends the pause can wait
     * on this very entry, so refusing it here would hold the pause for ever.
     */
    company: accountId,
    person,
    committeeKey: signed.committeeKey,
    signed: signed.entry,
    opening,
    signingSecret: keys.signingSecret,
    viewingKey: keyInForce(keys.viewingKey),
    ...(invited === null ? {} : { invited })
  });
  const filing: DirectoryFiling = { company: accountId, version: filings.length + 1, change: { kind: 'claim', entry } };
  await service.file(filing);
  return 'filed';
};

/**
 * What became of an owed entry: filed now, found already there, nothing owed, not yet taken and why, or held back
 * because this device cannot read the invitation behind its seat yet (`waitingForItsInvitation`, said in words the
 * person can act on). Only the first two let the entry go.
 */
export type OwedEntryFiled =
  | 'filed'
  | 'already-there'
  | 'nothing-owed'
  | { readonly notYet: string }
  | { readonly waitingForItsInvitation: string };

/** Said while a seat's own entry waits for the invitation behind it: what is waited for, and what happens next. */
export const WAITING_FOR_ITS_INVITATION =
  "your seat's entry in the company's directory is not filed yet: it must carry the invitation a " +
  "seat of the company signed for you, and this device could not read it from the company's proposals. Until it is filed " +
  'no device believes your seat, so you cannot approve or file anything. It is tried again in your next action in your wallet; ' +
  'if this stays, ask the signer who added you to make an action on the company in their wallet, or to invite you again';

/**
 * **A SIGNER'S DIRECTORY ENTRY, FILED FROM THEIR OWN DEVICE AS SOON AS THE
 * DIRECTORY WILL TAKE IT.** The entry is signed by their wallet in the press
 * that gives their vault keys at seating, and filed with the opening of their
 * seat this device made when it took the seat and the invitation a seat signed
 * for them, sealed under the company's roster key and signed by the seat's
 * filing key (`keys`), so it is filed only once this device can open the
 * company's key; it is believed only while the account holds the seat, which
 * may be later. So it is kept (`owed`) and filed again by this seat's
 * actions in its wallet until the directory holds it, and let go then.
 *
 * **NO ENTRY BUT THE FOUNDING SEAT'S IS FILED WITHOUT ITS INVITATION.** Every
 * member's device refuses one, so filing it would leave the seat on the chain
 * and believed by nobody. The invitation is kept from the link this device
 * accepted where it names the seat's leaf, and otherwise read from the
 * company's proposal that seated it, which names the leaf on every path; while it cannot be read the entry stays owed and the answer
 * says so (`waitingForItsInvitation`). The founding seat is the one the
 * account's deploy seated, as the person's own wallet reads it (`founding`).
 * An entry the directory already holds is `already-there` before anything else is asked, so a device whose keys hold no opening
 * of the seat is not told it is not filed.
 * A refusal is not an error here: it leaves the entry owed, and says why.
 */
export const fileTheOwedDirectoryEntry = async (
  accountId: string,
  owed: { read(): OwedDirectoryEntry | null; settle(): Promise<void> },
  keys: () => Promise<{ readonly signingSecret: Hex; readonly viewingKey: KeysHeld } | null>,
  /** The seat the account's deploy seated, as the person's own wallet reads it; null where it cannot be read. */
  founding: () => Promise<string | null>,
  /** The step's view of the company: the directory and the proposals are read, and the entry filed, through it. */
  view: EntryView
): Promise<OwedEntryFiled> => {
  const service = entryServiceOf(view);
  const now = owed.read();
  if (now === null) return 'nothing-owed';
  let done: 'filed' | 'already-there';
  try {
    if (now.opening === undefined) {
      /* An entry the directory already holds needs no opening to be filed: it is there, whatever the keys on this device hold. */
      const entry = now.signed.entry;
      const there = (await service.filings()).some(
        (f) =>
          f?.change?.kind === 'claim' &&
          f.change.entry?.statement?.seat === entry.seat &&
          f.change.entry.statement.signingKey === entry.signingKey &&
          f.change.entry.statement.wrappingKey === entry.wrappingKey
      );
      if (!there) {
        return {
          notYet:
            'this device holds no opening of its seat, so its entry cannot be filed. Take the seat again on this device'
        };
      }
      done = 'already-there';
    } else {
      const held = await keys();
      if (held === null) {
        return {
          notYet:
            "this device cannot open the company's key yet, so its entry cannot be sealed for the company's members. It is filed once you are admitted"
        };
      }
      /*
       * An invitation kept from a link names no leaf; the one an entry carries names it, and is read from the proposal that
       * seated it. An invitation made by address names the proposal instead, and is carried as it was kept: every device
       * binds the seat to it by what the account's history shows that proposal took.
       */
      const seat = now.signed.entry.seat.toLowerCase();
      const byAddress = now.invited?.terms.leaf === undefined && now.invited?.terms.proposal !== undefined;
      let invited = byAddress || now.invited?.terms.leaf?.toLowerCase() === seat ? (now.invited ?? null) : null;
      if (invited === null) {
        /* A list the service will not give is a wait, never a reason to file the entry without its invitation. */
        let listed: unknown = [];
        try {
          listed = await service.proposals();
        } catch {
          listed = [];
        }
        invited = seatInvitationIn(
          Array.isArray(listed) ? (listed as SealedProposal[]) : [],
          accountId,
          held.viewingKey,
          seat
        );
      }
      if (invited === null) {
        let first: string | null = null;
        try {
          first = await founding();
        } catch {
          first = null;
        }
        if (first === null || first.toLowerCase() !== seat)
          return { waitingForItsInvitation: WAITING_FOR_ITS_INVITATION };
      }
      done = await fileOwnDirectoryEntry(service, accountId, now.person, now.signed, now.opening, held, invited);
    }
  } catch (e) {
    return { notYet: (e as Error)?.message ?? String(e) };
  }
  await owed.settle();
  return done;
};

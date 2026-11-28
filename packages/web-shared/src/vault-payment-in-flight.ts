/**
 * **A PAYMENT OUT OF A VAULT WHILE IT IS ON ITS WAY**: what this device keeps of
 * it, the doors a payment out is built with, the failures that name it, a note
 * as the vault worker is handed one, and until when it can still land.
 */
import type { Hex } from '../../../src/core/crypto.js';
import type { Note } from '../../../src/midnight/vault-notes.js';
import type { NoteOnTheWire } from './vault-builder.js';
import type { VaultBuilderClient } from './vault-worker-client.js';
import type { KeptOnThisDevice } from './in-flight-on-this-device.js';
import { type ChainHereDoors, type PoolDoors } from './vault-doors.js';
import { timeShown } from './vault-step-reads.js';
import { DEPOSIT_CLOCKS_MAY_DIFFER_MS, DEPOSIT_TIME_TO_LIVE_MS } from './vault-private-deposit.js';
import type { RebuildDoors } from './vault-notes-here.js';

/* ------------------------------------------------------------ a payment out */

/**
 * **A PRIVATE PAYMENT THIS DEVICE HAS HANDED OVER TO BE SENT AND HAS NOT YET
 * RECORDED.** Kept on this device, sealed under the signer's own key, from
 * just before the send until the vault's record shows it. It keeps what
 * nothing else can give back: the coin the payment returns to the vault, read
 * when the payment was built, or, for a payment that returns none, its own
 * transaction's identifiers, by which alone the chain says it landed. Without
 * them, a payment that landed while this page was not watching leaves nothing
 * anyone can name it by.
 */
export interface PaymentInFlight {
  /** The note the payment spends first. */
  readonly spent: { readonly nonce: Hex; readonly token: Hex; readonly value: string };
  /** Every further note it spends, in place order; absent or empty when it spends one. */
  readonly further?: ReadonlyArray<{ readonly nonce: Hex; readonly token: Hex; readonly value: string }>;
  readonly amount: string;
  /** What the payment gives back to the vault, or `null` when it spends the note exactly; a merge's one coin. */
  readonly change: NoteOnTheWire | null;
  /** A merge of the vault's own notes, which sends nothing out; absent on a payment. */
  readonly merge?: true;
  /** When this was written, in milliseconds: after the payment was built and before it was sent. */
  readonly recordedAt: number;
  readonly txRef: string;
  readonly transactionHash: string | null;
  /**
   * For a payment that keeps no change, read before the send from the transaction handed over to be sent: every
   * identifier the chain can be asked about it by (binding it and merging a fee into it leave each one as it was).
   * Absent on a step that keeps a coin. A payment that keeps no coin and whose record lacks them cannot name its own
   * transaction, so it is never recorded as landed.
   */
  readonly identifiers?: readonly string[];
  /** The same transaction's earliest time to live, in milliseconds since the epoch: after it, it can no longer land. */
  readonly timeToLive?: number;
  /** The same transaction (base64), from which the worker reads its identifiers and its call to the vault again. */
  readonly transaction?: string;
}

/** One payment in flight per vault on this device, changed or forgotten only under the claim it was kept with. */
export type PaymentsInFlight = KeptOnThisDevice<PaymentInFlight>;

export interface PayoutDoors extends PoolDoors {
  readonly builder: VaultBuilderClient;
  readonly indexer: ChainHereDoors['indexer'];
  readonly now?: () => Date;
  /** Where this device keeps a payment it has sent until the vault's record shows it. */
  readonly inFlight: PaymentsInFlight;
  /** This device's own seat as its believed directory holds it: a rebuild on the way to a payment files only what its role may file. */
  readonly seatHere: RebuildDoors['seatHere'];
}

/**
 * **AN EARLIER PAYMENT OUT OF THIS VAULT FROM THIS BROWSER IS NOT IN THE
 * VAULT'S RECORD YET, AND CAN STILL BE.** No note is chosen for another: the
 * vault's record does not yet say which notes are left. `unread` when it is
 * held because something on the chain could not be read: then it stays held
 * until the chain can be read, whatever the time, and the words never name a
 * time after which it is let go.
 */
export class PaymentStillInFlight extends Error {
  readonly unread: boolean;
  constructor(
    readonly vault: Hex,
    readonly txRef: string,
    readonly until: number,
    why?: string,
    held: { readonly unread?: boolean } = {}
  ) {
    const at = timeShown(until);
    super(
      `an earlier payment out of this vault from this browser${txRef === '' ? '' : ` (${txRef})`} is not in the ` +
        `vault's record yet${why === undefined ? '' : ` (${why})`}, so no other payment is made from here until it is. ` +
        `Nothing new was prepared or sent. Try again in a minute: once the chain shows it, it is recorded first. ` +
        (held.unread === true
          ? 'The chain could not be read just now. This payment stays held, and no other payment leaves this vault from ' +
            'here, until it can be.'
          : `If the chain has not shown it by ${at}, it never will, and after then payments go ahead as soon as this ` +
            "vault's history can be read.")
    );
    this.name = 'PaymentStillInFlight';
    this.unread = held.unread === true;
  }
}

/**
 * **ANOTHER TAB OF THIS BROWSER STARTED A PAYMENT OUT OF THIS VAULT A MOMENT
 * AGO.** This one stops before it is sent.
 */
export class PaymentStartedElsewhere extends Error {
  constructor(readonly vault: Hex) {
    super(
      'another payment out of this vault started in another tab or window of this browser a moment ago, so this one ' +
        'was not sent. No money moved. When the other one has finished, open the run again, and pay this person only if ' +
        'it still shows them unpaid.'
    );
    this.name = 'PaymentStartedElsewhere';
  }
}

/**
 * **THE PAYMENT MAY HAVE BEEN SENT, AND THIS DEVICE HAS NOT SEEN IT LAND.** The
 * money may have moved. Raised for every failure after the service began
 * sending, whatever it was, so no screen reads it as a payment that did not
 * happen.
 */
export class PaymentNotYetSeen extends Error {
  constructor(
    readonly vault: Hex,
    readonly txRef: string,
    why?: string
  ) {
    super(
      `the payment may have been sent${txRef === '' ? '' : ` (${txRef})`} and this device has not seen it land` +
        `${why === undefined ? '' : ` (${why})`}, so it may still land. Do not pay this person again: open the run ` +
        'later, and it shows them paid once the chain does. This browser keeps a locked record of the payment, and the ' +
        'next payment out of this vault from here, or "Check my last deposit" on the vault, adds it to the vault\'s ' +
        'record once the chain shows it. Until then, no other payment leaves this vault from this browser.'
    );
    this.name = 'PaymentNotYetSeen';
  }
}

/**
 * **THE PAYMENT LANDED, AND THE VAULT'S RECORD WAS NOT WRITTEN.** The person is
 * paid. The sealed note of the payment is kept, and the next look from this
 * browser writes the record.
 */
export class PaymentLandedUnrecorded extends Error {
  constructor(
    readonly vault: Hex,
    readonly transactionHash: string,
    why: string
  ) {
    super(
      `the payment landed${transactionHash === '' ? '' : ` (${transactionHash})`} and the vault's record could not ` +
        `be written (${why}). The person is paid: do not pay them again. This browser keeps a locked record of the ` +
        'payment, and the next payment out of this vault from here, or "Check my last deposit" on the vault, writes ' +
        'the record.'
    );
    this.name = 'PaymentLandedUnrecorded';
  }
}

/**
 * **A TRANSACTION UNDER THIS PAYMENT'S NAME IS ON THE CHAIN, AND IT IS NOT THE
 * PAYMENT THIS DEVICE BUILT.** Nothing is recorded from it, and waiting will not
 * change what it says.
 */
export class PaymentNotAsBuilt extends Error {
  constructor(
    readonly vault: Hex,
    readonly transactionHash: string,
    why: string
  ) {
    super(
      `the chain holds a transaction under this payment's name${transactionHash === '' ? '' : ` (${transactionHash})`} that is not the payment this ` +
        `device built: ${why}. The vault's record is not changed for it now. Do not pay this person again until the ` +
        "run shows whether they were paid. If the vault's record still holds the note it spent once the chain no " +
        "longer does, the record has to be rebuilt from the company's records before this device spends that note."
    );
    this.name = 'PaymentNotAsBuilt';
  }
}

/**
 * **A PAYMENT THE CHAIN REFUSED.** Its own transaction is on the chain, and the
 * part of it that carries this vault's payout did not take effect, so no money
 * left the vault by it. It is let go at once.
 */
export class PaymentRefusedOnChain extends Error {
  constructor(
    readonly vault: Hex,
    readonly transactionHash: string
  ) {
    super(
      `the chain refused the payment${transactionHash === '' ? '' : ` (${transactionHash})`}, so no money left the ` +
        'vault by it and nobody was paid by it. The run shows whether this person is still owed: open it again before ' +
        'paying them.'
    );
    this.name = 'PaymentRefusedOnChain';
  }
}

/** A note as the page's vault worker is handed one: its value written as whole digits. */
export const wireOf = (n: Note): NoteOnTheWire => ({
  nonce: n.nonce,
  token: n.token,
  value: n.value.toString(),
  ...(n.createdIn === undefined ? {} : { createdIn: n.createdIn })
});
export type NoteAsHex = { readonly nonce: Hex; readonly token: Hex; readonly value: string; readonly createdIn?: Hex };
export const noteOf = (wire: NoteOnTheWire): Note => {
  const n = wire as unknown as NoteAsHex;
  return {
    nonce: n.nonce,
    token: n.token,
    value: BigInt(n.value),
    ...(n.createdIn === undefined ? {} : { createdIn: n.createdIn })
  };
};

/** What a payment kept on this device left, once it is settled. */
export type PaymentSettled =
  | { readonly state: 'none' | 'already-recorded' | 'never-landed' | 'spent-elsewhere' | 'not-matched' | 'overtaken' }
  | { readonly state: 'recorded'; readonly createdIn: Hex | null };

/** The one circuit of the vault a payment out of it calls. */
export const A_PAYOUT: readonly string[] = ['payout'];

/**
 * **UNTIL WHEN A PAYMENT ON ITS WAY CAN STILL LAND.** Never before
 * `DEPOSIT_TIME_TO_LIVE_MS` after it was kept; for a record that kept its own
 * transaction's time to live, never before that time plus the one margin for
 * clocks that differ (`DEPOSIT_CLOCKS_MAY_DIFFER_MS`).
 */
export const paymentLandsBy = (p: PaymentInFlight): number => {
  const kept = p.recordedAt + DEPOSIT_TIME_TO_LIVE_MS;
  return typeof p.timeToLive === 'number' && Number.isFinite(p.timeToLive)
    ? Math.max(kept, p.timeToLive + DEPOSIT_CLOCKS_MAY_DIFFER_MS)
    : kept;
};

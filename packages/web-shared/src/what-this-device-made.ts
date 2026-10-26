/**
 * **AN APPROVAL IS PROVED ONLY FOR WHAT THIS DEVICE MADE AGAIN ITSELF.**
 *
 * A proposal's identity on the chain is a hash of what it pays, its window, its
 * vault and its salt. The service hands a device that identity, and could hand
 * one for a run the signers never saw: other people, other amounts, another
 * month, or a second payment for a month already paid. So before an approval
 * is proved, the device builds the run again from the company's records it
 * opened and believed - every payee's leaf from the company's own payout seed
 * and pay-record key, the root over them, the payload - and proves the approval
 * only when that payload, under the proposal's own vault and salt, is the
 * proposal the chain holds open.
 *
 * Which seat's signature makes the company state believed is settled where the
 * run is read (`runRebuiltHere`): the seat the account's deploy seated, as the
 * person's own wallet read it. It also holds the run to three facts the
 * person's own wallet read off the chain (`WalletReadFacts`), never to the
 * account state the service served:
 *   - that the pay-record key in that state is the one the account committed
 *     to, so every person-month nonce is the one the chain records payments
 *     under;
 *   - that nobody the run pays is already recorded as paid for that person,
 *     month and kind of pay; and
 *   - that a numbered extra payment is the next one: the payment before it was
 *     made. A run that pays a first extra while the regular payment is still
 *     unpaid is refused, since it would be two payments for one month.
 *
 * A vault's first secret run is made again here from the secret, the vault and
 * the readers it is sealed to, so no run but a secret run can pass as one.
 *
 * A one-off payment is made again here from its record: its one leaf from the
 * record's payee, amount and seed, the salt from the seed's fresh half, and the
 * once-mark of the seed's nonce read by the person's own wallet as not yet
 * held. A proposal whose run is anything else than what its record says is
 * refused, whatever the record says.
 */
import { buildOneOffRun, buildRetryRun, buildRun, paidOnceOfNonce, type DetailsOfKind, type PaymentFacts } from '../../../src/midnight/payout-tree.js';
import { oneOffEntryOf, oneOffSaltOf, oneOffSecretsOf, payRecordNonceOf, type PayoutSeed, type PayRecord, type RunIdentity } from '../../../src/midnight/run-keys.js';
import { fromHex, toHex, type Hex } from '../../../src/core/crypto.js';
import { firstSecretRunOf, type AccountStartPure, type VaultStartPure } from '../../../src/midnight/vault-start.js';
import { NO_LEG } from '../../../src/midnight/spending-policy-record.js';
import { vouchedFreshOf, vouchedRefusal, type Vouched } from '../../../src/midnight/record-tree.js';

/**
 * What a payroll run's salt was made from, as its proposal seals it, and
 * whether this device checked that head itself: true only where the proposal
 * was opened or raised on this device and its own database of the heads it
 * checked holds that head.
 */
export type VouchedHere = Vouched & { readonly checkedHere?: boolean };

/** A payroll run, as this device rebuilt it from the company's records. */
export interface RunMadeHere {
  readonly kind: 'payroll';
  /** From the company state the founding seat signed. */
  readonly seeds: readonly PayoutSeed[];
  readonly payKey: string;
  readonly identity: RunIdentity;
  /** Every payment on the leg, in the leg's order, from the people this device believed. */
  readonly facts: readonly PaymentFacts[];
  readonly records: readonly PayRecord[];
  readonly asset: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly required: string;
  /**
   * For a retry: the positions on the leg it pays. A retry is raised over the
   * leg's own tree, so its root is the leg's; only these people are paid by it,
   * so only they are checked as not yet paid.
   */
  readonly retry?: readonly number[];
  /**
   * For a raise: what the company's records already account for, so what the
   * chain holds beyond it is found before a new round is sent.
   */
  readonly raising?: RaisingHere;
  /**
   * What the person's own wallet read off the chain about this run's payments
   * (`withWhatTheWalletRead`): whether each person is already paid for the
   * month, whether an extra payment's predecessor was made, and the account's
   * commitment to its pay-record key. Absent, the run is refused.
   */
  readonly wallet?: WalletReadFacts;
}

/**
 * **FACTS OF THE ACCOUNT'S STATE, AS THE PERSON'S OWN WALLET READ THEM.** The
 * proof of an approval binds only the account's open proposals, so these are
 * read through the wallet rather than taken from the account state the service
 * serves: the entries of its record of payments that were asked about, those
 * of them it holds, its pay-record key commitment, every proposal it holds
 * open, and how many entries its record of payments holds in all.
 */
export interface WalletReadFacts {
  readonly payKeyCommitment: string | null;
  readonly asked: readonly string[];
  readonly held: readonly string[];
  readonly openRounds: readonly string[];
  readonly entries: number;
}

/**
 * **WHAT A RAISE IS CHECKED AGAINST ON THE CHAIN, BESIDES THE RUN ITSELF.**
 * Every round the company's records hold, every leaf and payment nonce of every
 * leg they hold, and what a run drawn as a repeat confirmed it repeats; and,
 * beside payroll's and never among them, the leaf and nonce of every one-off
 * payment the company's records hold, which leave their own entries.
 */
export interface RaisingHere {
  readonly period: string;
  readonly knownRounds: readonly string[];
  readonly knownLeaves: readonly string[];
  readonly knownNonces: readonly string[];
  /** Every one-off payment's leaf and nonce this device read from the company's one-off records. */
  readonly oneOffs?: { readonly leaves: readonly string[]; readonly nonces: readonly string[] };
  readonly confirmed?: { readonly of: readonly string[]; readonly chainPayments?: number };
}

/** A vault's first secret run: what it is made from, so it is made again where the approval is built. */
interface SecretRunMadeHere {
  readonly kind: 'vault-secret';
  readonly vault: string;
  readonly secret: string;
  readonly readers: readonly string[];
  readonly opensAt: string;
  readonly closesAt: string;
}

/** A one-off payment from a vault, as this device read it from its record: what the run is made again from. */
export interface OneOffMadeHere {
  readonly kind: 'transfer';
  readonly asset: string;
  /** Its one payment: the payee, the token moved and the amount. */
  readonly facts: PaymentFacts;
  /** The seed its record seals, its secrets' one source (`oneOffSecretsOf`). */
  readonly seed: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly required: string;
  /** What the person's own wallet read of the once-mark of its nonce; absent, an approval is refused. */
  readonly wallet?: { readonly asked: readonly string[]; readonly held: readonly string[] };
}

export type MadeHere = RunMadeHere | SecretRunMadeHere | OneOffMadeHere;

/** The parts of the account's ledger this check reads. */
export interface AccountLedgerView {
  readonly openProposals: { member(id: Uint8Array): boolean };
  readonly movements: { member(entry: Uint8Array): boolean };
}

interface MadeHereDeps {
  readonly runPayload: (root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint, required: bigint) => Uint8Array;
  /** The account's own commitment to a pay-record key. */
  readonly payKeyCommitmentOf?: (key: Uint8Array) => Uint8Array;
  /** The account's and the vault's circuits a vault's first secret run is made with. */
  readonly secretRun?: { readonly vault: VaultStartPure; readonly account: AccountStartPure };
  /** The vault's two details circuits, without which no payee's leaf can be made here. */
  readonly vaultDetails?: DetailsOfKind;
  /** The account's own salt of a run: `retrySaltOf(leg, fresh)`, the leg none unless the run pays a leg's people again. */
  readonly retrySaltOf?: (leg: Uint8Array, fresh: Uint8Array) => Uint8Array;
}

/** Why an approval was not built: this device could not make again what the proposal pays. */
export class NotMadeOnThisDevice extends Error {
  constructor(why: string) {
    super(`${why} Nothing was built or sent.`);
    this.name = 'NotMadeOnThisDevice';
  }
}

const DO_NOT = 'Do not approve it, and tell the person who raised it.';
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const digits = (what: string, v: string): bigint => {
  if (!/^[0-9]+$/u.test(String(v))) throw new NotMadeOnThisDevice(`what this device worked out for the ${what} is not a whole number.`);
  return BigInt(v);
};

/**
 * Refuses unless `made` is a run or a vault's secret run this device made
 * again, whose payload is `digest`, and the chain holds `chainId` open.
 */
export function refuseWhatThisDeviceDidNotMake(
  deps: MadeHereDeps,
  opened: {
    readonly chainId: string; readonly digest: string; readonly vault?: string; readonly salt?: string;
    /**
     * For a payroll run: the head of the company's records its raiser checked
     * and the random value, sealed in its proposal beside the salt, which the
     * fresh half of the salt is made from (`vouchedFreshOf`); and whether this
     * device checked that head itself, as its own database of the heads it
     * checked holds it - set where the proposal is opened on this device.
     */
    readonly vouched?: VouchedHere;
    readonly made?: MadeHere;
  },
  ledger: AccountLedgerView | null,
  /** An approval is of a proposal the chain holds open; a raise is of one it does not hold yet. */
  when: 'approve' | 'raise' = 'approve',
): void {
  const made = opened.made;
  if (made === undefined) {
    throw new NotMadeOnThisDevice('This device did not rebuild what this proposal pays from the company\'s own records, '
      + (when === 'raise' ? 'so it will not raise it. Reload the page and raise it from the company\'s runs.'
        : 'so it will not approve it. Reload the page and approve it from the company\'s proposals.'));
  }
  if (ledger === null) {
    throw new NotMadeOnThisDevice('This page cannot read the company\'s account on the chain, so it cannot check this '
      + 'proposal. Reload the page to get the current version.');
  }
  if (when === 'approve' && !ledger.openProposals.member(fromHex(opened.chainId))) {
    throw new NotMadeOnThisDevice('The chain holds no open proposal by this name, so there is nothing to approve. Reload '
      + 'the page to see where it stands.');
  }
  if (when === 'raise') {
    if (made.kind !== 'payroll' && made.kind !== 'transfer') {
      throw new NotMadeOnThisDevice('This device raises payroll runs and one-off payments here, and this is neither.');
    }
    if (ledger.openProposals.member(fromHex(opened.chainId))) {
      throw new NotMadeOnThisDevice('The chain already holds this proposal open, so there is nothing to send. Reload the '
        + 'page to see where it stands.');
    }
    /* What the chain holds beyond the company's records is judged by the raise checks over these, before anything is built. */
    if (made.kind === 'payroll' && made.raising === undefined) {
      throw new NotMadeOnThisDevice('This device did not read what the company\'s records account for on the chain, so it will '
        + 'not raise this run. Reload the page and raise it again.');
    }
  }
  let root: Hex;
  let payees: bigint;
  let window: { opensAt: bigint; closesAt: bigint };
  let required = 0n;
  if (made.kind === 'vault-secret') {
    if (deps.secretRun === undefined) {
      throw new NotMadeOnThisDevice('This page cannot make a vault\'s first secret run again, so it will not approve one. '
        + 'Reload the page to get the current version.');
    }
    const secretRun = firstSecretRunOf(deps.secretRun, {
      vault: made.vault.toLowerCase() as Hex, secret: made.secret.toLowerCase() as Hex, readers: made.readers.map((r) => r.toLowerCase() as Hex),
    });
    root = secretRun.root;
    payees = secretRun.payees;
    window = { opensAt: digits('window', made.opensAt), closesAt: digits('window', made.closesAt) };
  } else if (made.kind === 'transfer') {
    if (deps.vaultDetails === undefined || deps.retrySaltOf === undefined) {
      throw new NotMadeOnThisDevice(`This page cannot make a one-off payment again, so it will not ${when === 'raise' ? 'raise' : 'approve'} one. `
        + 'Reload the page to get the current version.');
    }
    let built: ReturnType<typeof buildOneOffRun>;
    let secrets: ReturnType<typeof oneOffSecretsOf>;
    try {
      secrets = oneOffSecretsOf(made.seed as Hex);
      built = buildOneOffRun(made.facts, secrets, deps.vaultDetails, made.asset);
    } catch (e) {
      throw new NotMadeOnThisDevice(`This one-off payment's record cannot be made into a payment (${(e as Error)?.message ?? String(e)}). ${DO_NOT}`);
    }
    /* Its salt is a first payment's, made from the record's own seed: never a leg's retry, which the chain charges nothing. */
    if (opened.salt === undefined || !same(oneOffSaltOf(secrets, deps.retrySaltOf), opened.salt)) {
      throw new NotMadeOnThisDevice(`This proposal's salt was not made from its one-off payment's record, so the chain would not charge it as `
        + `that payment. ${DO_NOT}`);
    }
    if (when === 'approve') {
      const read = made.wallet;
      const entry = oneOffEntryOf(secrets, (nonce) => fromHex(paidOnceOfNonce(toHex(nonce))));
      if (read === undefined || !read.asked.some((e) => e.toLowerCase() === entry)) {
        throw new NotMadeOnThisDevice('Your wallet did not read whether this one-off payment was already paid, so this device will not '
          + 'approve it. Reload the page and try again.');
      }
      if (read.held.some((e) => e.toLowerCase() === entry)) {
        throw new NotMadeOnThisDevice(`This one-off payment is already recorded as paid, so it would be refused when paid. ${DO_NOT}`);
      }
    }
    root = built.tree.root;
    payees = built.tree.payees;
    window = { opensAt: digits('window', made.opensAt), closesAt: digits('window', made.closesAt) };
    required = digits('approvals required', made.required);
  } else {
    if (deps.payKeyCommitmentOf === undefined) {
      throw new NotMadeOnThisDevice('This page cannot read the company\'s pay-record key off the chain, so it will not '
        + 'approve a payroll run. Reload the page to get the current version.');
    }
    /*
     * **THE PAY-RECORD KEY AND WHO IS PAID ARE READ BY THE PERSON'S OWN WALLET,
     * NEVER FROM THE ACCOUNT STATE THE SERVICE SERVED.** The proof binds only
     * the open proposals; a served state could say nobody was paid, or commit
     * to another key, and nothing on the chain would refuse it.
     */
    const read = made.wallet;
    if (read === undefined) {
      throw new NotMadeOnThisDevice('Your wallet did not read whether the people on this run were already paid, so this '
        + `device will not ${when === 'raise' ? 'raise' : 'approve'} it. Reload the page and try again.`);
    }
    const asked = new Set(read.asked.map((e) => e.toLowerCase()));
    const held = new Set(read.held.map((e) => e.toLowerCase()));
    const paidOnce = (nonce: Hex): boolean => {
      const entry = paidOnceOfNonce(nonce).toLowerCase();
      if (!asked.has(entry)) {
        throw new NotMadeOnThisDevice('Your wallet was not asked about every payment on this run, so this device cannot say '
          + 'who on it was already paid. Reload the page and try again.');
      }
      return held.has(entry);
    };
    const committed = read.payKeyCommitment;
    if (committed === null || !same(toHex(deps.payKeyCommitmentOf(fromHex(made.payKey))), committed)) {
      throw new NotMadeOnThisDevice('The company state this run was rebuilt from carries a pay-record key other than the '
        + `one the company committed to on the chain, so its payments would not be recorded as the chain records them. ${DO_NOT}`);
    }
    if (deps.vaultDetails === undefined) {
      throw new NotMadeOnThisDevice('This page cannot rebuild a payroll run, so it will not approve one. Reload the page '
        + 'to get the current version.');
    }
    const built = buildRun(
      [...made.seeds], made.identity, [...made.facts], deps.vaultDetails,
      { key: made.payKey as Hex, records: [...made.records] }, made.asset);
    const positions = made.retry ?? made.facts.map((_, i) => i);
    if (made.retry !== undefined && (made.retry.length === 0
      || made.retry.some((i) => !Number.isInteger(i) || i < 0 || i >= built.tree.leaves.length)
      || new Set(made.retry).size !== made.retry.length)) {
      throw new NotMadeOnThisDevice(`This retry names people who are not on the run it retries. ${DO_NOT}`);
    }
    /* A retry is raised over a tree of its own, of only the people it names. */
    const raised = made.retry === undefined ? built : buildRetryRun(built, [...made.retry]);
    /*
     * **WHAT THE PROPOSAL'S SALT SAYS IT IS, AND WHAT THE RECORD SAYS, AGREE.**
     * The account charges a run as what its salt was made as: a run whose salt
     * names a leg is charged nothing while that leg's charge stands. So the salt
     * is made again here, from the fresh half sealed in the proposal beside its
     * salt and, for a retry, the root of the leg built again above, and must be
     * the proposal's.
     * A run that looks like a first payment but whose salt names a leg, or a
     * retry whose salt names another leg, is refused.
     */
    if (deps.retrySaltOf === undefined) {
      throw new NotMadeOnThisDevice('This page cannot make a run\'s salt again, so it cannot tell whether the run pays somebody '
        + 'again without a charge. Reload the page to get the current version.');
    }
    const vouched = opened.vouched;
    if (vouched === undefined || vouchedRefusal(vouched) !== null) {
      throw new NotMadeOnThisDevice('The company\'s record of this proposal does not say how its salt was made, so this '
        + 'device cannot tell whether it pays somebody again without a charge. It was raised before this version: withdraw '
        + 'it and raise it again.');
    }
    /*
     * **AN APPROVAL VOUCHES FOR THE HEAD ITS RUN WAS RAISED OVER**, since the
     * salt the chain approves is made from it: so it is given only over a head
     * this device checked itself, never over one only its raiser read.
     */
    if (vouched.checkedHere !== true) {
      throw new NotMadeOnThisDevice('This run was raised over the company\'s records as they stood at a point this device has '
        + 'not checked itself, so it will not approve it. Reload the page so this device reads the company\'s records, then '
        + 'approve it again; if it is still refused, this device began checking the records after that point: check them '
        + 'from the first and approve it again.');
    }
    const fresh = vouchedFreshOf(vouched.head as Hex, vouched.r as Hex);
    const leg = made.retry === undefined ? NO_LEG() : fromHex(built.tree.root);
    if (opened.salt === undefined || !same(toHex(deps.retrySaltOf(leg, fromHex(fresh))), opened.salt)) {
      throw new NotMadeOnThisDevice(made.retry === undefined
        ? 'This proposal\'s salt says it pays a leg\'s people again, while the company\'s record says it is a first payment, '
          + `so the chain would charge it nothing against that leg's charge. ${DO_NOT}`
        : 'This retry\'s salt was not made over the leg it pays again, so the chain would charge it as some other leg\'s '
          + `retry. ${DO_NOT}`);
    }
    root = raised.tree.root;
    payees = raised.tree.payees;
    for (const i of positions) {
      const record = made.records[i]!;
      const nonce = payRecordNonceOf(made.payKey as Hex, record);
      if (paidOnce(nonce)) {
        throw new NotMadeOnThisDevice(`This run pays somebody already recorded as paid for ${record.month}, so it would `
          + `be refused when paid. ${DO_NOT}`);
      }
      if (record.occurrence > 0 && !paidOnce(payRecordNonceOf(made.payKey as Hex, { ...record, occurrence: record.occurrence - 1 }))) {
        throw new NotMadeOnThisDevice(`This run pays an extra payment for ${record.month} to somebody whose payment `
          + `before it has not been made, so it would pay them twice for one month. ${DO_NOT}`);
      }
    }
    window = { opensAt: digits('window', made.opensAt), closesAt: digits('window', made.closesAt) };
    required = digits('approvals required', made.required);
  }
  const payload = toHex(deps.runPayload(fromHex(root), payees, window.opensAt, window.closesAt, required));
  if (!same(payload, opened.digest)) {
    throw new NotMadeOnThisDevice('What this proposal pays is not what this device rebuilt from the company\'s records: '
      + `other people, other amounts, another month or another window. ${DO_NOT}`);
  }
}

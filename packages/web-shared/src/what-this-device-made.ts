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
 */
import { buildRetryRun, buildRun, paidOnceOfNonce, type DetailsOfKind, type PaymentFacts } from '../../../src/midnight/payout-tree.js';
import { payRecordNonceOf, type PayoutSeed, type PayRecord, type RunIdentity } from '../../../src/midnight/run-keys.js';
import { fromHex, toHex, type Hex } from '../../../src/core/crypto.js';
import { firstSecretRunOf, type AccountStartPure, type VaultStartPure } from '../../../src/midnight/vault-start.js';

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
 * leg they hold, and what a run drawn as a repeat confirmed it repeats.
 */
export interface RaisingHere {
  readonly period: string;
  readonly knownRounds: readonly string[];
  readonly knownLeaves: readonly string[];
  readonly knownNonces: readonly string[];
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

export type MadeHere = RunMadeHere | SecretRunMadeHere;

/** The parts of the account's ledger this check reads. */
export interface AccountLedgerView {
  readonly openProposals: { member(id: Uint8Array): boolean };
  readonly movements: { member(entry: Uint8Array): boolean };
  readonly signerRoles: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
}

interface MadeHereDeps {
  readonly runPayload: (root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint, required: bigint) => Uint8Array;
  /** The account's own commitment to a pay-record key. */
  readonly payKeyCommitmentOf?: (key: Uint8Array) => Uint8Array;
  /** The account's and the vault's circuits a vault's first secret run is made with. */
  readonly secretRun?: { readonly vault: VaultStartPure; readonly account: AccountStartPure };
  /** The vault's two details circuits, without which no payee's leaf can be made here. */
  readonly vaultDetails?: DetailsOfKind;
  /** The key under which the account marks a vault that pays only runs cleared against its spending policy. */
  readonly policyOnKeyOf?: (vault: Uint8Array) => Uint8Array;
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
  deps: MadeHereDeps, opened: { readonly chainId: string; readonly digest: string; readonly vault?: string; readonly made?: MadeHere },
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
    if (made.kind !== 'payroll') {
      throw new NotMadeOnThisDevice('This device raises payroll runs here, and this is not one.');
    }
    if (ledger.openProposals.member(fromHex(opened.chainId))) {
      throw new NotMadeOnThisDevice('The chain already holds this proposal open, so there is nothing to send. Reload the '
        + 'page to see where it stands.');
    }
    /* What the chain holds beyond the company's records is judged by the raise checks over these, before anything is built. */
    if (made.raising === undefined) {
      throw new NotMadeOnThisDevice('This device did not read what the company\'s records account for on the chain, so it will '
        + 'not raise this run. Reload the page and raise it again.');
    }
    refuseAVaultNoDeviceCanClear(deps, opened.vault, ledger);
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

/**
 * **A RAISE IS SENT ONLY TO A VAULT WHOSE RUNS IT CAN PAY.** A vault the
 * account marks as paying only runs cleared against its spending policy is
 * refused: a run there is paid only when its whole window lies in one of the
 * policy's periods, and no device holds a vault's policy, so no window raised
 * here can be shown to. Whether the chain holds anything the company's records
 * cannot account for is one of the raise checks every raising and approving
 * device runs before it builds anything (`raise-checks-here.ts`).
 */
function refuseAVaultNoDeviceCanClear(deps: MadeHereDeps, vault: string | undefined, ledger: AccountLedgerView): void {
  if (vault === undefined || !/^[0-9a-f]{64}$/iu.test(vault)) {
    throw new NotMadeOnThisDevice('This device cannot tell which vault this run is paid from, so it will not raise it.');
  }
  if (deps.policyOnKeyOf === undefined) {
    throw new NotMadeOnThisDevice('This page cannot read whether the vault pays only runs cleared against a spending policy, '
      + 'so it will not raise a run. Reload the page to get the current version.');
  }
  if (ledger.signerRoles.member(deps.policyOnKeyOf(fromHex(vault.toLowerCase())))) {
    throw new NotMadeOnThisDevice('The vault this run is paid from pays only runs cleared against its spending policy, and '
      + 'a run is cleared only when its whole window lies in one of the policy\'s periods. This device does not hold the '
      + 'vault\'s policy, so it cannot show this window does. Raise the run from a vault with no spending policy.');
  }
}

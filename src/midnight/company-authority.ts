/**
 * **WHO HOLDS A COMPANY'S RULES: ITS ACCOUNT AND EVERY VAULT, AS THE CHAIN
 * SAYS, AND THE ONE CHANGE THIS SERVICE MAY SIGN.**
 *
 * Every contract a company has carries its own maintenance authority: a list of
 * signature keys and how many of them must sign a change to the contract's
 * rules. Whoever meets that threshold can replace the proofs the contract
 * accepts. On the company account that is every vault's money at once, because
 * a vault pays out on the account's approval and the account's approval is a
 * proof the account's rules decide.
 *
 * So a company sees one list - its committee: one key per signer, at the
 * company's own threshold - and underneath it that list is copied into the
 * account and into each vault. This file answers, per contract and from the
 * chain alone, whether the copy is the company's, and which seats are held by
 * somebody who is no longer on the company.
 *
 * **HOW A COMPANY ACCOUNT COMES TO BE HELD BY ITS COMMITTEE.** A contract's
 * address is a hash of what it is deployed with, its authority included, and a
 * signer's committee key is worked out from the company's address. No account
 * can therefore be deployed already holding keys that are derived from its own
 * address. The account is deployed with this service's temporary key and handed
 * to the committee afterwards, exactly as a vault is: the temporary key signs
 * that one change, and nothing is paid into any of the company's vaults until
 * the chain shows the committee holding the account.
 *
 * **WHAT NOTHING HERE CAN MAKE TRUE.** The chain checks only signatures. A
 * change the company's signers agreed to and a change enough key-holders signed
 * without asking anybody look the same to it. No sentence built from this file
 * may say the chain required the company's approval.
 *
 * Imports nothing that loads WebAssembly: the ledger's classes are handed in.
 */
import type { AuthorityRead, AuthorityShape, MaintenanceEndStateRecord, MaintenancePrimitives } from './ledger.js';
import {
  attachMaintenanceSignature, buildMaintenanceInstruction, compareAuthority, planAuthorityReplacement,
  signatureProgress,
} from './ledger.js';
import type { Committee, CommitteeKey } from './vault-committee.js';

const idOf = (k: { tag: string; value: string }): string => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`;

/* ------------------------------------------------------------- the seats */

/** One seat on a contract's committee, as the chain holds it. */
export interface Seat {
  readonly key: CommitteeKey;
  /** The signer who gave this key for this company and is on it now, or `null` when nobody on the company did. */
  readonly holder: string | null;
  /** Whether this is the temporary key this service itself keeps. */
  readonly thisService: boolean;
  /** Whether this key is on the company's committee as it stands now. */
  readonly onTheCompanysCommittee: boolean;
}

export type ContractKind = 'account' | 'vault';

/** What a company is shown about one of its contracts. */
export interface ContractAuthorityView {
  readonly contract: ContractKind;
  readonly address: string;
  /** Whether the chain answered, and the answer could be read. */
  readonly read: AuthorityRead['state'];
  readonly seats: readonly Seat[];
  readonly threshold: number | null;
  /** How many times this contract's rules have been changed. */
  readonly changes: string | null;
  readonly shape: AuthorityShape | null;
  /** `true` only when the chain carries exactly the company's committee. */
  readonly heldByTheCompany: boolean;
  /**
   * **SEATS HELD BY A KEY THE COMPANY'S COMMITTEE DOES NOT HAVE.** A signer who
   * has left keeps their seat on every contract nobody has changed since, and
   * the chain accepts their signature there exactly as before.
   */
  readonly seatsOutsideTheCommittee: number;
  readonly why: string;
}

/**
 * **ONE CONTRACT'S AUTHORITY, AS A COMPANY READS IT.**
 *
 * `holders` maps a committee key to the signer on the company now who gave it.
 * A seat whose key nobody on the company now gave - a signer who has left, or
 * a key nobody here ever gave - has no holder, and is counted as outside the
 * committee. `serviceKey` is the temporary key this service keeps, when it
 * keeps one, so that seat is named as this service's rather than as nobody's.
 */
export function authorityView(
  contract: ContractKind,
  read: AuthorityRead,
  committee: Committee | null,
  holders: ReadonlyMap<string, string>,
  serviceKey: CommitteeKey | null = null,
): ContractAuthorityView {
  const base = { contract, address: read.address, read: read.state };
  if (read.state !== 'read') {
    return {
      ...base, seats: [], threshold: null, changes: null, shape: null, heldByTheCompany: false,
      seatsOutsideTheCommittee: 0,
      why: `the chain could not be asked who holds this ${contract}'s rules: ${read.why}`,
    };
  }
  const current = new Set((committee?.committee ?? []).map(idOf));
  const seats = read.authority.committee.map((k) => ({
    key: { tag: k.tag, value: k.value },
    holder: holders.get(idOf(k)) ?? null,
    thisService: serviceKey !== null && idOf(serviceKey) === idOf(k),
    onTheCompanysCommittee: current.has(idOf(k)),
  }));
  const outside = seats.filter((s) => !s.onTheCompanysCommittee).length;
  const ours = seats.some((s) => s.thisService);
  const verdict = committee === null
    ? null
    : compareAuthority(read, { committee: committee.committee.map((k) => ({ ...k })), threshold: committee.threshold });
  const held = verdict?.verdict === 'agree';
  const why = read.authority.shape === 'anyone'
    ? `ANYBODY can change this ${contract}'s rules: its threshold is ${read.authority.threshold}, so a change `
      + 'needs no signature at all.'
    : held
      ? `the company's committee holds this ${contract}: ${committee!.committee.length} key(s), `
        + `${committee!.threshold} of them needed to change its rules.`
      : committee === null
        ? `this company has no complete committee yet, so nothing can be compared with this ${contract}.`
        : ours
          ? `THIS SERVICE'S temporary key holds this ${contract}'s rules, so this service could change them `
            + (contract === 'account' ? 'and with them what every vault of the company pays out. ' : 'on its own. ')
            + 'Hand it to the company\'s committee.'
        : outside > 0
          ? `${outside} seat(s) on this ${contract} are held by a key that is not on the company's committee now. `
            + 'Whoever holds those keys can still sign changes to its rules, alone or with others, until the '
            + `${contract} is changed.`
          : `this ${contract} is not held by the company's committee as it stands now: ${verdict!.why}`;
  return {
    ...base,
    seats,
    threshold: read.authority.threshold,
    changes: String(read.authority.counter),
    shape: read.authority.shape,
    heldByTheCompany: held,
    seatsOutsideTheCommittee: outside,
    why,
  };
}

/* ------------------------------------------------ everyone must be present */

/**
 * **WHAT A COMPANY IS TOLD BEFORE ITS MONEY GOES IN, WHEN ONE LOST SIGNER IS
 * ENOUGH TO STRAND IT.** `null` when a signer can be lost and the rest can
 * still act.
 *
 * A signer's committee key is worked out from their recovery words, which their
 * recovery pieces can rebuild. Their key for approving a payment is not: it is
 * kept in their saved keys, which this service stores sealed and their wallet
 * opens. Losing either for good loses that signer. When the threshold is the
 * whole company, every signer is needed for any change and for any payout.
 */
export function everySignerNeeded(signerCount: number, threshold: number): string | null {
  if (!Number.isInteger(signerCount) || signerCount < 1 || threshold < signerCount) return null;
  if (signerCount === 1) {
    return 'You are this company\'s only signer, so every change to its rules and every payment out of its '
      + 'vaults needs you. If your recovery words are lost together with every wallet that holds your identity '
      + 'and enough of your recovery pieces to rebuild them, or if your saved keys are lost, nobody can ever pay '
      + 'out what its vaults hold: the money stays there for good, and nothing this service runs can move it. '
      + 'Losing the words that way also means nobody can ever change this company\'s rules again. Adding a '
      + 'second signer, and keeping the threshold below the number of signers, means losing one person no '
      + 'longer does this.';
  }
  return `Every one of this company's ${signerCount} signers is needed for every change to its rules and every `
    + 'payment out of its vaults. If any one of them loses their recovery words together with every wallet '
    + 'that holds their identity and enough of their recovery pieces to rebuild them, or their saved keys are '
    + 'lost, nobody can ever pay out what its vaults hold: the money stays there for good. A threshold below '
    + 'the number of signers means losing one person no longer does this.';
}

/* ----------------------------------------------- whether money may go in */

/**
 * **`null` ONLY WHEN THE CHAIN SHOWS THE COMPANY'S ACCOUNT HELD BY ITS
 * COMMITTEE, CHANGED EXACTLY ONCE, AND RUNNING THIS BUILD'S CIRCUITS.**
 *
 * A vault pays out on its account's approval, so a vault held by the company's
 * committee is still paid out of by whoever holds the account's rules. The
 * account's own handover is its one permitted change: a key that held the
 * account before could have swapped a circuit, used it, and put it back, and
 * the chain would then show the committee and this build's circuits.
 *
 * `circuitsRefusal` is the caller's reading of the account's circuits against
 * this build's, `null` when they are the same.
 */
export function accountFundingRefusal(
  read: AuthorityRead, committee: Committee, circuitsRefusal: string | null,
): string | null {
  const verdict = compareAuthority(read, {
    committee: committee.committee.map((k) => ({ ...k })), threshold: committee.threshold,
  });
  if (verdict.verdict === 'unknown') {
    return 'the chain could not be asked who holds this company\'s account, and a vault pays out on the '
      + 'account\'s approval, so no money goes in. Nothing was sent; try again when the chain answers.';
  }
  if (verdict.verdict === 'disagree') {
    const shape = read.state === 'read' ? read.authority.shape : null;
    return shape === 'one-key' && read.state === 'read' && read.authority.counter === 0n
      ? 'this company\'s account is still held by the temporary key it was created with, and a vault pays out '
        + 'on the account\'s approval, so no money goes into any of its vaults. Hand the account to the '
        + 'company\'s committee in Settings first. Nothing was sent.'
      : 'this company\'s account is not held by the company\'s committee on the chain, and a vault pays out on '
        + `the account's approval, so no money goes in: ${verdict.why} Nothing was sent.`;
  }
  if (read.state !== 'read' || read.authority.counter !== 1n) {
    const changes = read.state === 'read' ? String(read.authority.counter) : 'an unknown number of';
    return `this company's account has had its rules changed ${changes} times, and an account handed straight `
      + 'to its committee has been changed once, so what it approves cannot be vouched for and no money goes '
      + 'in. Nothing was sent.';
  }
  if (circuitsRefusal !== null) return circuitsRefusal;
  return null;
}

/* ------------------------------------------------ the account's handover */

/** The ledger this service builds the account's handover with. `@midnightntwrk/ledger-v9` satisfies it. */
export interface AccountHandoverLedger extends MaintenancePrimitives {
  signatureVerifyingKey(signingKey: CommitteeKey): CommitteeKey;
  signData(signingKey: CommitteeKey, data: Uint8Array): CommitteeKey;
  Intent: { new: (ttl: Date) => { addMaintenanceUpdate(update: unknown): unknown } };
  Transaction: { fromParts(network: string, guaranteed: undefined, fallible: undefined, intent: unknown): unknown };
}

/**
 * **THE ONE CHANGE THIS SERVICE'S TEMPORARY KEY SIGNS ON A COMPANY ACCOUNT: THE
 * ACCOUNT HANDED TO THE COMPANY'S COMMITTEE.** Built from what the chain holds
 * now, refused unless the account is still exactly as it was deployed - held
 * by that one key and never changed - and returned unproven, for the caller to
 * prove and send.
 *
 * The replacement goes through the product's one authority builder, so the
 * committee it installs is refused for the same reasons as any other: a
 * threshold of nothing, a threshold above the members, no members, a key
 * listed twice.
 */
export function buildAccountHandover(
  L: AccountHandoverLedger,
  input: {
    readonly read: AuthorityRead;
    readonly to: Committee;
    readonly temporaryKey: CommitteeKey;
    readonly network: string;
    readonly ttl: Date;
  },
): { unproven: unknown; endState: MaintenanceEndStateRecord } {
  const { read } = input;
  if (read.state !== 'read') {
    throw new Error(`the chain could not be asked who holds this company's account (${read.why}), so nothing was built.`);
  }
  if (read.authority.shape !== 'one-key') {
    throw new Error('this company\'s account is no longer held by one key, so there is nothing for this service to '
      + 'hand over. Nothing was built.');
  }
  if (read.authority.counter !== 0n) {
    throw new Error('this company\'s account has already had its rules changed by the key it was created with, so it '
      + 'is not handed over as if it were new, and no money goes into its vaults. Nothing was built.');
  }
  const mine = L.signatureVerifyingKey(input.temporaryKey);
  if (idOf(mine) !== idOf(read.authority.committee[0]!)) {
    throw new Error('this company\'s account is held by a key this service does not keep, so this service cannot hand '
      + 'it over. Nothing was built.');
  }
  const plan = planAuthorityReplacement(read, input.to, { emptyCommitteeIsDeliberate: false });
  if (plan.action === 'refuse') throw new Error(`the account will not be handed over: ${plan.why}`);
  if (plan.action === 'settled') throw new Error('this company\'s account is already held by its committee. Nothing was built.');
  let built = buildMaintenanceInstruction(L, plan, { label: 'company account', emptyCommitteeIsDeliberate: false });
  built = attachMaintenanceSignature(L, built, 0, L.signData(input.temporaryKey, built.dataToSign));
  if (!signatureProgress(built).complete) {
    throw new Error('the account\'s handover is not signed by enough of the keys that hold it now. Nothing was built.');
  }
  const unproven = L.Transaction.fromParts(
    input.network, undefined, undefined, L.Intent.new(input.ttl).addMaintenanceUpdate(built.update));
  return { unproven, endState: built.endState };
}

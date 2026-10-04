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
 * **HOW A COMPANY ACCOUNT COMES TO BE HELD BY ITS COMMITTEE.** A signer's
 * committee key is worked out from the company's label, which exists before the
 * account does. Today the account is still deployed with this service's
 * temporary key and handed to the committee afterwards, exactly as a vault is:
 * the temporary key signs
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
import type {
  AuthorityRead, AuthorityShape, MaintenanceEndStateRecord, MaintenancePrimitives, MaintenanceSignature,
} from './ledger.js';
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

/* ------------------------------------------- a committee's own threshold */

/**
 * **A COMMITTEE IS NEVER LOOSER THAN THE CONTRACT IT HOLDS.** Whoever meets a
 * contract's committee threshold can replace every proof the contract accepts,
 * so a vault that needs three approvals to pay, held by a committee that two
 * keys can change, in truth needs two. A committee's threshold is therefore at
 * least the strictest approval bar its contract enforces - for a vault, that
 * vault's own threshold; for the company account, the highest of the company's
 * threshold and every vault's - and at most the keys it holds.
 *
 * `null` when the committee meets that rule; otherwise the sentence saying why
 * not and what to change.
 *
 * **REPORTED, NOT YET REFUSED.** Today every committee this product builds sits
 * at the company's threshold, so refusing here would stop every committee
 * change for a company with one stricter vault: a signer who left would keep
 * their seats and a signer who joined could never be paid. The builders below
 * return this verdict beside what they build; the refusal is switched on when
 * committees can be built above the company's threshold. Until then no screen
 * may say a vault needs more approvals than the company's threshold.
 */
export function committeeLooserThanItsContract(to: Committee, strictestBar: number, label: string): string | null {
  if (!Number.isInteger(strictestBar) || strictestBar < 1) {
    return `the approvals ${label} needs could not be read, so no committee was built for it. Nothing was built.`;
  }
  if (strictestBar > to.committee.length) {
    return `${label} needs ${strictestBar} approvals for some payments and its committee would hold ${to.committee.length} `
      + `key(s), so no committee can be as strict as it is. Lower that bar to at most ${to.committee.length} first. `
      + 'Nothing was built.';
  }
  if (to.threshold < strictestBar) {
    return `${label} needs ${strictestBar} approvals for some payments, and this committee could change its rules with `
      + `${to.threshold} of its keys. Its committee needs at least ${strictestBar}, or that bar is lowered to `
      + `${to.threshold} first. Nothing was built.`;
  }
  return null;
}

/* ----------------------------------------------- whether money may go in */

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
    /** The highest approval bar the account enforces: the company's threshold and every vault's. */
    readonly strictestBar: number;
    readonly temporaryKey: CommitteeKey;
    readonly network: string;
    readonly ttl: Date;
  },
): { unproven: unknown; endState: MaintenanceEndStateRecord; looserThanItsContract: string | null } {
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
  return {
    unproven,
    endState: built.endState,
    looserThanItsContract: committeeLooserThanItsContract(input.to, input.strictestBar, 'this company\'s account'),
  };
}

/* ----------------------------------------------- a committee changed after */

/** One signature on a committee change: the seat it was made for on the committee that holds the contract now. */
export interface SeatSignature {
  readonly seat: number;
  readonly signature: MaintenanceSignature;
}

/** The ledger the service assembles a committee change with. `@midnightntwrk/ledger-v9` satisfies it. */
export interface CommitteeChangeLedger extends MaintenancePrimitives {
  Intent: { new: (ttl: Date) => { addMaintenanceUpdate(update: unknown): unknown } };
  Transaction: { fromParts(network: string, guaranteed: undefined, fallible: undefined, intent: unknown): unknown };
}

/**
 * **A CONTRACT'S COMMITTEE REPLACED BY THE COMPANY'S, SIGNED BY THE COMMITTEE
 * THAT HOLDS IT NOW.** Every signature was made in its signer's own wallet and
 * arrives here on its own; this checks each against the seat it claims, puts
 * them on the one update the chain will accept, and says how many more are
 * needed. When enough have signed it returns the transaction unproven, for the
 * caller to prove and send.
 *
 * **NO KEY IS A PARAMETER OF THIS FUNCTION.** It takes signatures, which are
 * public once the change reaches the chain and are good for this one update
 * only: the update names the contract, the whole new committee and the counter
 * the chain holds now, so a signature collected for it verifies against no
 * other contract, no other committee and no later counter.
 *
 * Refused here, before anything is built: a contract whose rules need no
 * signature or can never be changed, a contract
 * already held by the company's committee, and anything the product's one
 * authority builder refuses about the new committee. A committee looser than
 * the strictest approval bar the contract enforces is reported, not refused.
 */
export function buildCommitteeChange(
  L: CommitteeChangeLedger,
  input: {
    readonly read: AuthorityRead;
    readonly to: Committee;
    /** The highest approval bar this contract enforces: a vault's own, or the account's highest. */
    readonly strictestBar: number;
    readonly signatures: readonly SeatSignature[];
    readonly network: string;
    readonly ttl: Date;
    readonly label: string;
  },
): {
  readonly have: number;
  readonly required: number;
  readonly seatsSigned: number[];
  readonly unproven: unknown | null;
  readonly endState: MaintenanceEndStateRecord;
  /** Whether this committee is looser than the contract it holds; see `committeeLooserThanItsContract`. */
  readonly looserThanItsContract: string | null;
} {
  const { read } = input;
  if (read.state !== 'read') {
    throw new Error(`the chain could not be asked who holds ${input.label}'s rules (${read.why}), so nothing was built.`);
  }
  /*
   * A contract held by one key and never changed is built for like any other:
   * born held, that is a one-signer company's founding signer, and this change
   * is how its second signer joins. Whether the contract was born held is the
   * record's to say, and the door the change is paid through asks it.
   */
  if (read.authority.shape === 'anyone' || read.authority.shape === 'no-one') {
    throw new Error(`${input.label}'s rules ${read.authority.shape === 'anyone' ? 'need no signature at all' : 'can never be changed'}, `
      + 'so a change signed by the company\'s signers is not built for it. Nothing was built.');
  }
  const plan = planAuthorityReplacement(read, input.to, { emptyCommitteeIsDeliberate: false });
  if (plan.action === 'refuse') throw new Error(`the committee will not be changed: ${plan.why}`);
  if (plan.action === 'settled') throw new Error(`${input.label} is already held by the company's committee. Nothing was built.`);
  let built = buildMaintenanceInstruction(L, plan, { label: input.label, emptyCommitteeIsDeliberate: false });
  for (const s of [...input.signatures].sort((a, b) => a.seat - b.seat)) {
    built = attachMaintenanceSignature(L, built, s.seat, s.signature);
  }
  const progress = signatureProgress(built);
  return {
    have: progress.have,
    required: progress.required,
    seatsSigned: progress.seatsSigned,
    unproven: progress.complete
      ? L.Transaction.fromParts(input.network, undefined, undefined, L.Intent.new(input.ttl).addMaintenanceUpdate(built.update))
      : null,
    endState: built.endState,
    looserThanItsContract: committeeLooserThanItsContract(input.to, input.strictestBar, input.label),
  };
}

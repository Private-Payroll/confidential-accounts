/**
 * **WHAT STARTING A VAULT ASKS OF THE CHAIN, AND WHAT THE CHAIN SAYS IS DONE.**
 *
 * A vault takes no money until three things are on the chain, in this order:
 *
 *   1. its company's account has ADOPTED it: a governance round over
 *      `adoptVaultPayload(vault)`, approved at the account's threshold, carried
 *      out by `adopt`;
 *   2. a NONCE SECRET is set: a run for this vault alone, whose one leaf is
 *      `secretRunDetails(vault, previous, commitment, copiesRoot, count)` at an
 *      amount of nothing, approved at the vault's bar, after which the vault's
 *      `setNonceSecret` asks the account's `approveVaultChange`. `previous` is
 *      zero for the first secret and the commitment the vault holds for one that
 *      replaces it; a replacement also carries the last secret every copy was
 *      written for (`earlier`), which the vault keeps sealed under the new one;
 *   3. EVERY SIGNER'S SEALED COPY of that secret is written (`writeSecretCopy`).
 *
 * This module makes everything those calls are built from, with the contracts'
 * own functions, and reads off the two ledgers how far a vault has got. Nothing
 * here sends anything or holds a key; the device's start (`vault-operation.ts`)
 * acts on what it answers, one step at a time, each only once the chain shows
 * the one before.
 *
 * **EVERY VALUE IS MADE THE SAME WAY EVERY TIME, SO A START CAN BE RUN AGAIN.**
 *
 *   · The adoption's salt is a hash of the vault's address, and for a vault the
 *     company retired and adopts again of the proposal that retired it, under a
 *     domain of its own. The adoption's identity is then public as soon as the
 *     vault is, and so is the adoption itself once carried out, so nothing is
 *     lost by it, and any signer's device finds the same proposal without being
 *     told about it.
 *   · The secret run's salt and its leaf's nonce are derived from the secret
 *     itself, which only the company's signers can open, so the run's identity
 *     says nothing to anybody else until it is used.
 *   · The sealed copies are sealed the same way every time
 *     (`sealed-secret-copy.ts`), to every reader the filed secret is wrapped to,
 *     in the order of their keys, so the tree of copies is the one approved.
 *   · The run's window is the one thing chosen when it is raised. It is not
 *     written down anywhere: the account keeps every run's window beside its
 *     identity, so the run is found again by trying each window the account
 *     holds against the identity this run would have with it.
 *
 * **THE SECRET RUN'S ASSET.** A change moves no money and its one leaf carries
 * an amount of nothing, and the account checks the leaf against the run's root
 * in the asset the vault hands it. A change is in no asset, so the root is made
 * in the marker that is no asset: the bytes of `NO_ASSET`.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromHex, toHex, utf8, type Hex } from '../core/crypto.js';
import { NO_ASSET } from '../core/assets.js';
import { copiesTreeOf, type CopiesTreeCircuits, type CopyStep } from './sealed-copies-tree.js';
import { sealSecretCopy } from './sealed-secret-copy.js';
import { sumTreeOfLeaves, type SumStep } from './payout-tree.js';

const HEX32 = /^[0-9a-f]{64}$/u;
const ZERO = new Uint8Array(32);
const ADOPTION_SALT = utf8('confidential-accounts/vault-adoption-salt/v1');
const RUN_SALT = utf8('confidential-accounts/vault-secret-run/salt/v1');
const RUN_NONCE = utf8('confidential-accounts/vault-secret-run/nonce/v1');

/** The vault's own functions a start is made from. */
export interface VaultStartPure extends CopiesTreeCircuits {
  secretCommitmentOf(vault: Uint8Array, secret: Uint8Array): Uint8Array;
  secretRunDetails(vault: Uint8Array, previous: Uint8Array, commitment: Uint8Array, copies: Uint8Array, count: bigint): Uint8Array;
  copyKeyOf(commitment: Uint8Array, reader: Uint8Array, place: bigint, part: bigint): Uint8Array;
  copiesRootKeyOf(commitment: Uint8Array): Uint8Array;
  copiesWrittenKey(): Uint8Array;
}

/** The account's own functions a start is made from. */
export interface AccountStartPure {
  adoptVaultPayload(vault: Uint8Array): Uint8Array;
  noVault(): Uint8Array;
  proposalIdOf(payload: Uint8Array, vault: Uint8Array, salt: Uint8Array): Uint8Array;
  runPayload(root: Uint8Array, payees: bigint, opensAt: bigint, closesAt: bigint, required: bigint): Uint8Array;
  payoutLeaf(details: Uint8Array, nonce: Uint8Array): Uint8Array;
  removalCountKey(): Uint8Array;
}

const vaultBytes = (vault: string): Uint8Array => {
  if (typeof vault !== 'string' || !HEX32.test(vault)) {
    throw new Error('a vault is named by its address, 64 lower-case hex characters, and this is not one. Nothing was built.');
  }
  return fromHex(vault);
};

/* ------------------------------------------------------------ 1. adoption */

/** The adoption round for one vault: the payload its signers approve, the salt, and the identity they make. */
export interface AdoptionRound {
  readonly vault: Hex;
  readonly payload: Hex;
  readonly salt: Hex;
  readonly proposal: Hex;
}

/**
 * The adoption round of a vault, made the same way on every device. A vault the company retired and adopts again
 * passes `again`, the proposal that retired it: the account never forgets a seat's approval of a proposal, so an
 * adoption made again under the first one's identity could never gather its approvals. Refuses an `again` that is not
 * a proposal's identity.
 */
export function adoptionRoundOf(P: AccountStartPure, vault: Hex, again?: Hex): AdoptionRound {
  const v = vaultBytes(vault);
  const payload = P.adoptVaultPayload(v);
  const salt = fromHex(adoptionSaltOf(vault, again));
  return { vault, payload: toHex(payload), salt: toHex(salt), proposal: toHex(P.proposalIdOf(payload, P.noVault(), salt)) };
}

/**
 * The salt of a vault's adoption round, and of its adoption again under `again`, the proposal that retired it: the
 * same on every device. Refuses an `again` that is not a proposal's identity.
 */
export function adoptionSaltOf(vault: Hex, again?: Hex): Hex {
  if (again !== undefined && (typeof again !== 'string' || !HEX32.test(again))) {
    throw new Error('the proposal that retired this vault is named by 64 lower-case hex characters, and this is not one. Nothing was built.');
  }
  return toHex(sha256(new Uint8Array([...ADOPTION_SALT, ...vaultBytes(vault), ...(again === undefined ? [] : fromHex(again))])));
}

/* ------------------------------------------------------------ 2. the secret run */

/** One signer's sealed copy, where it sits in the approved tree. */
export interface SecretCopyToWrite {
  readonly reader: Hex;
  readonly parts: readonly Hex[];
  readonly path: readonly CopyStep[];
}

/** Everything the first secret run is raised with and the secret is set with, made from the secret alone. */
export interface SecretRun {
  readonly vault: Hex;
  readonly previous: Hex;
  readonly commitment: Hex;
  readonly copies: readonly SecretCopyToWrite[];
  readonly copiesRoot: Hex;
  readonly count: bigint;
  /** The path to the first place past the last copy, which shows the vault no copy sits beyond the count. */
  readonly edge: readonly CopyStep[];
  readonly details: Hex;
  readonly nonce: Hex;
  readonly salt: Hex;
  /** The marker that is no asset, as bytes: what the run's root is made in. */
  readonly asset: Hex;
  readonly root: Hex;
  readonly payees: bigint;
  /** The one leaf's path in the run's sum tree. */
  readonly path: readonly SumStep[];
}

/**
 * **A SECRET RUN FOR A VAULT**, from the secret it sets, the readers it is sealed
 * to and the commitment it replaces. `readers` are the public halves of the
 * signers' records keys; each gets one sealed copy. `previous` is the commitment
 * the vault holds when the run is raised, zero (or absent) for its first secret;
 * the run's leaf binds it, so the run sets its secret only over that one.
 */
export function secretRunOf(
  circuits: { readonly vault: VaultStartPure; readonly account: AccountStartPure },
  input: { readonly vault: Hex; readonly secret: Hex; readonly readers: readonly Hex[]; readonly previous?: string },
): SecretRun {
  const V = circuits.vault;
  const P = circuits.account;
  const v = vaultBytes(input.vault);
  if (typeof input.secret !== 'string' || !HEX32.test(input.secret)) {
    throw new Error('a vault\x27s secret is thirty-two bytes, and this is not one. Nothing was built.');
  }
  if (!input.secret.toLowerCase().endsWith('00')) {
    throw new Error('a vault\x27s secret ends in a zero byte, so a later secret can carry it. This one does not, so '
      + 'nothing was built. Make the company\x27s record of the secret again before starting the vault.');
  }
  const readers = [...new Set(input.readers.map((r) => String(r).toLowerCase()))].sort();
  if (readers.length === 0 || readers.some((r) => !HEX32.test(r))) {
    throw new Error('a secret is sealed to every signer\x27s records key, and none was given that is one. Nothing was built.');
  }
  if (input.previous !== undefined && (typeof input.previous !== 'string' || !HEX32.test(input.previous))) {
    throw new Error('the commitment a secret run replaces is 64 lower-case hex characters, and this is not one. Nothing was built.');
  }
  const previous = input.previous === undefined ? ZERO : fromHex(input.previous);
  const secret = fromHex(input.secret);
  const commitment = V.secretCommitmentOf(v, secret);
  const sealed = readers.map((reader) => ({
    reader, parts: sealSecretCopy({ vault: input.vault, secret: input.secret, reader }),
  }));
  const tree = copiesTreeOf(V, commitment, sealed.map((c) => ({ reader: fromHex(c.reader), parts: c.parts })));
  const details = V.secretRunDetails(v, previous, commitment, tree.root, tree.count);
  const salt = hkdf(sha256, secret, RUN_SALT, v, 32);
  const nonce = hkdf(sha256, secret, RUN_NONCE, v, 32);
  const leaf = toHex(P.payoutLeaf(details, nonce));
  const asset = NO_ASSET;
  const sum = sumTreeOfLeaves([leaf], [0n], asset);
  return {
    vault: input.vault,
    previous: toHex(previous),
    commitment: toHex(commitment),
    copies: sealed.map((c, i) => ({ reader: c.reader, parts: c.parts.map(toHex), path: tree.paths[i]! })),
    copiesRoot: toHex(tree.root),
    count: tree.count,
    edge: tree.edge,
    details: toHex(details),
    nonce: toHex(nonce),
    salt: toHex(salt),
    asset,
    root: sum.root,
    payees: 1n,
    path: sum.pathFor(0),
  };
}

const payloadOf = (P: AccountStartPure, run: SecretRun, window: { readonly opensAt: bigint; readonly closesAt: bigint }): Hex =>
  toHex(P.runPayload(fromHex(run.root), run.payees, window.opensAt, window.closesAt, 0n));

/** The run's identity with one window. */
export const secretRunProposalOf = (
  P: AccountStartPure, run: SecretRun, window: { readonly opensAt: bigint; readonly closesAt: bigint },
): Hex => toHex(P.proposalIdOf(
  P.runPayload(fromHex(run.root), run.payees, window.opensAt, window.closesAt, 0n), fromHex(run.vault), fromHex(run.salt)));

/**
 * The public parts of a vault's secret run, as the transaction that set its secret discloses them; numbers in decimal
 * digits. `previous`, the commitment the run replaced, is absent for a first secret.
 */
export interface FirstSecretRunParts {
  readonly root: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly salt: string;
  readonly nonce: string;
  readonly copiesRoot: string;
  readonly count: string;
  readonly previous?: string;
}

const DIGITS = /^[0-9]{1,20}$/u;

/**
 * **A VAULT'S SECRET RUN, MADE AGAIN FROM ITS PUBLIC PARTS** once its secret is set, with the contracts' own
 * functions: its identity on the chain and its payload, and the root a secret run of these parts has under a
 * secret's commitment, over the commitment it replaced (zero for a first secret). The run's one leaf names the commitment it sets (`secretRunDetails`), so the run whose root is
 * the one made under the commitment a vault holds is a run that set that secret. Nothing here is a key: every part is
 * disclosed on the chain by the call that set the secret. Refuses a part that is not one.
 */
export function firstSecretRunCarriedOf(
  circuits: { readonly vault: VaultStartPure; readonly account: AccountStartPure }, vault: Hex, parts: FirstSecretRunParts,
): { readonly proposal: Hex; readonly payload: Hex; rootUnder(commitment: string): Hex } {
  const V = circuits.vault;
  const P = circuits.account;
  const v = vaultBytes(vault);
  const hexes = [parts.root, parts.salt, parts.nonce, parts.copiesRoot];
  if (parts.previous !== undefined) hexes.push(parts.previous);
  if (hexes.some((h) => typeof h !== 'string' || !HEX32.test(h)) || [parts.opensAt, parts.closesAt, parts.count].some((n) => typeof n !== 'string' || !DIGITS.test(n))) {
    throw new Error('these are not the public parts of a secret run: four or five values of 64 lower-case hex characters and three whole numbers.');
  }
  const previous = parts.previous === undefined ? ZERO : fromHex(parts.previous);
  const payload = P.runPayload(fromHex(parts.root), 1n, BigInt(parts.opensAt), BigInt(parts.closesAt), 0n);
  return {
    proposal: toHex(P.proposalIdOf(payload, v, fromHex(parts.salt))),
    payload: toHex(payload),
    rootUnder: (commitment) => {
      if (typeof commitment !== 'string' || !HEX32.test(commitment)) throw new Error('a secret\x27s commitment is 64 lower-case hex characters, and this is not one.');
      const details = V.secretRunDetails(v, previous, fromHex(commitment), fromHex(parts.copiesRoot), BigInt(parts.count));
      return sumTreeOfLeaves([toHex(P.payoutLeaf(details, fromHex(parts.nonce)))], [0n], NO_ASSET).root;
    },
  };
}

/* ------------------------------------------------------------ reading the chain */

/** The parts of the account's ledger a start reads. */
export interface AccountLedgerForAStart {
  readonly threshold: bigint;
  readonly vaults: { member(v: Uint8Array): boolean };
  readonly thresholds: { member(v: Uint8Array): boolean; lookup(v: Uint8Array): bigint };
  readonly openProposals: { member(id: Uint8Array): boolean };
  readonly approvalCounts: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): bigint };
  readonly proposalHolds: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): { needed: bigint; removals: bigint } };
  readonly runWindow: Iterable<[Uint8Array, { opensAt: bigint; closesAt: bigint }]>;
}

/*
 * **THE ACCOUNT'S OWN SET OF ADOPTED VAULTS, ON THE CHAIN**, read by the field
 * name the compiled ledger gives it. Named through a constant so it is not
 * mistaken for a lookup in the operator's record of vaults by name, which this
 * is not: nothing here resolves a vault's name.
 */
const ADOPTED_SET = 'vaults' as const;
const adoptedSetOf = (a: AccountLedgerForAStart) => a[ADOPTED_SET];

/** The parts of the vault's ledger a start reads. */
export interface VaultLedgerForAStart {
  readonly nonceCommitment: Uint8Array;
  readonly secretCopies: { member(k: Uint8Array): boolean; lookup(k: Uint8Array): Uint8Array };
}

/** Where one proposal stands on the account. */
export interface RoundStanding {
  readonly proposal: Hex;
  /** Open on the account now. */
  readonly open: boolean;
  readonly approvals: number;
  /** How many approvals carrying it out needs now. */
  readonly needed: number;
  /**
   * A governance round a signer was removed since it was raised: the account never carries it out. Always false for a
   * run, whose bar only rises by one per removal since its raise (`needed`); a device's own rule on a secret run raised
   * before a removal is `beforeARemoval`.
   */
  readonly stale: boolean;
  /** Read for a seat: the account holds that seat's approval marker for it, so the account refuses the seat's approve. */
  readonly approvedHere?: boolean;
}

/** A proposal as a device raises or approves it: what it commits to, under which vault, with which salt. */
export interface RoundMadeOf {
  readonly payload: Hex;
  /** The vault the proposal names: `noVault()` for a governance round. */
  readonly named: Hex;
  readonly salt: Hex;
}

/** How far one vault's start has got, as the two ledgers say. */
export interface StartStanding {
  readonly adopted: boolean;
  readonly adoption: RoundStanding & RoundMadeOf;
  /** The removals and re-seats the account has counted, as the same block shows them. */
  readonly removals: number;
  /** Absent until the secret run is known: the secret is opened first, from the company's record or this seat's copy. */
  readonly secret?: {
    /** The vault holds this run's secret. */
    readonly set: boolean;
    /** The vault holds a secret that is neither this run's nor the one it replaces. */
    readonly another: boolean;
    /** The commitment the vault holds now, zero before its first secret. */
    readonly held: Hex;
    /** Every identity the account holds this run under, over any window, landed whether or not in its window now. */
    readonly landed: readonly Hex[];
    /**
     * Only when the device handed secrets to try: the one whose copies were last all written (`copiesWrittenKey`), which
     * a replacement must carry; null when none was ever written, `unheld` when none of those handed over is it.
     */
    readonly earlier?: { readonly secret: Hex } | { readonly unheld: true } | null;
    /** The approved root of copies on the chain is this run's. */
    readonly rootIsThisRuns: boolean;
    /** The run, when the account holds it under one of its windows. */
    readonly run: (RoundStanding & RoundMadeOf & { readonly opensAt: bigint; readonly closesAt: bigint; readonly inWindow: boolean; readonly beforeARemoval: boolean }) | null;
    /** The run as it would be raised with the window asked about, when one was. */
    readonly raise?: RoundMadeOf & { readonly proposal: Hex; readonly opensAt: bigint; readonly closesAt: bigint };
    /** For each copy, in the run's order, whether the vault holds it. */
    readonly written: readonly boolean[];
    /** The vault takes money: its secret is this one and every copy is written. */
    readonly started: boolean;
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export const removalsSoFar = (P: Pick<AccountStartPure, 'removalCountKey'>, a: Pick<AccountLedgerForAStart, 'proposalHolds'>): bigint => {
  const key = P.removalCountKey();
  return a.proposalHolds.member(key) ? a.proposalHolds.lookup(key).removals : 0n;
};

/**
 * Where one proposal stands on the account, at `bar` approvals, as the account's ledger holds it. With `approvedHere`,
 * whether the account holds one seat's approval marker for a proposal, it also says whether that seat's approval is
 * already counted.
 */
export const standingOf = (
  P: Pick<AccountStartPure, 'removalCountKey'>, a: Pick<AccountLedgerForAStart, 'openProposals' | 'approvalCounts' | 'proposalHolds'>,
  proposal: Hex, bar: bigint, isRun: boolean, approvedHere?: (id: Uint8Array) => boolean,
): RoundStanding => {
  const id = fromHex(proposal);
  const open = a.openProposals.member(id);
  const mine = approvedHere === undefined ? {} : { approvedHere: approvedHere(id) };
  if (!open) return { proposal, open, approvals: 0, needed: Number(bar), stale: false, ...mine };
  const hold = a.proposalHolds.member(id) ? a.proposalHolds.lookup(id) : { needed: bar, removals: removalsSoFar(P, a) };
  const removed = removalsSoFar(P, a) - hold.removals;
  const higher = hold.needed > bar ? hold.needed : bar;
  return {
    proposal, open,
    approvals: Number(a.approvalCounts.member(id) ? a.approvalCounts.lookup(id) : 0n),
    needed: Number(isRun ? higher + removed : higher),
    stale: !isRun && removed !== 0n,
    ...mine,
  };
};

/**
 * **HOW FAR A VAULT'S START OR SECRET RUN HAS GOT**, read off the account's and
 * the vault's ledgers as one block holds them. `run` is the secret run once its
 * secret has been opened; `now` is in seconds. A run raised before a signer was
 * removed (`beforeARemoval`: the removals the account counts now are more than
 * when the run was raised) seals copies to whoever held seats then, so the
 * device never approves or carries it.
 */
export function startStandingOf(
  circuits: { readonly vault: VaultStartPure; readonly account: AccountStartPure },
  input: {
    readonly vault: Hex; readonly account: AccountLedgerForAStart; readonly vaultLedger: VaultLedgerForAStart;
    readonly run?: SecretRun; readonly now: bigint;
    /** A window to make the run's identity with, for a device about to raise it. */
    readonly window?: { readonly opensAt: bigint; readonly closesAt: bigint };
    /** Whether the account holds this device's seat's approval marker for a proposal: each round then says so. */
    readonly approvedHere?: (id: Uint8Array) => boolean;
    /** Secrets this device holds for the vault, to find the one a replacement carries among (`earlier`). */
    readonly earlier?: readonly string[];
    /** For a vault the company retired and adopts again, the proposal that retired it (`adoptionRoundOf`). */
    readonly again?: Hex;
  },
): StartStanding {
  const V = circuits.vault;
  const P = circuits.account;
  const a = input.account;
  const mine = input.approvedHere;
  const v = vaultBytes(input.vault);
  const adoption = adoptionRoundOf(P, input.vault, input.again);
  const adopted = adoptedSetOf(a).member(v);
  const out: StartStanding = {
    adopted, removals: Number(removalsSoFar(P, a)),
    adoption: {
      ...standingOf(P, a, adoption.proposal, a.threshold, false, mine),
      payload: adoption.payload, named: toHex(P.noVault()), salt: adoption.salt,
    },
  };
  if (input.run === undefined) return out;
  const run = input.run;
  const commitment = fromHex(run.commitment);
  const onChain = input.vaultLedger.nonceCommitment;
  const set = sameBytes(onChain, commitment);
  const another = !set && onChain.some((b) => b !== 0) && !sameBytes(onChain, fromHex(run.previous));
  const rootKey = V.copiesRootKeyOf(commitment);
  const copies = input.vaultLedger.secretCopies;
  const rootIsThisRuns = copies.member(rootKey) && sameBytes(copies.lookup(rootKey), fromHex(run.copiesRoot));
  const written = run.copies.map((c, place) => copies.member(V.copyKeyOf(commitment, fromHex(c.reader), BigInt(place), 0n)));
  const writtenKey = V.copiesWrittenKey();
  const started = set && copies.member(writtenKey) && sameBytes(copies.lookup(writtenKey), commitment);
  const bar = a.thresholds.member(v) ? a.thresholds.lookup(v) : a.threshold;
  const runs: NonNullable<NonNullable<StartStanding['secret']>['run']>[] = [];
  for (const [id, window] of a.runWindow) {
    if (toHex(id) !== secretRunProposalOf(P, run, window)) continue;
    runs.push({
      ...standingOf(P, a, toHex(id), bar, true, mine),
      payload: payloadOf(P, run, window), named: run.vault, salt: run.salt,
      opensAt: window.opensAt, closesAt: window.closesAt,
      inWindow: window.opensAt <= input.now && input.now < window.closesAt,
      beforeARemoval: removedSinceRaised(P, a, id),
    });
  }
  const landed = runs.map((r) => r.proposal);
  const found = runFor(runs, input.window === undefined ? undefined : secretRunProposalOf(P, run, input.window));
  const raise = input.window === undefined ? {} : {
    raise: {
      proposal: secretRunProposalOf(P, run, input.window), payload: payloadOf(P, run, input.window), named: run.vault,
      salt: run.salt, opensAt: input.window.opensAt, closesAt: input.window.closesAt,
    },
  };
  const earlier = input.earlier === undefined ? {} : { earlier: earlierOf(V, v, copies, input.earlier) };
  return { ...out, secret: { set, another, held: toHex(onChain), landed, rootIsThisRuns, run: found, written, started, ...raise, ...earlier } };
}

/**
 * **WHICH OF A SECRET'S RUNS A READ REPORTS**, of all the account holds for it (`runs`, in the ledger's order): the one
 * under `wanted` when the read names its window, so a device approving or carrying a run reads that run and no other;
 * otherwise the first in its window, else the last. Two runs of one secret can be open at once (one raised before a
 * removal, one after); which the ledger lists first must not decide which is read.
 */
export const runFor = <R extends { readonly proposal: Hex; readonly inWindow: boolean }>(runs: readonly R[], wanted?: Hex): R | null =>
  (wanted === undefined ? undefined : runs.find((r) => r.proposal.toLowerCase() === wanted.toLowerCase()))
  ?? runs.find((r) => r.inWindow) ?? runs[runs.length - 1] ?? null;

/** Whether a signer was removed after the proposal `id` was raised: the account's removals now exceed those it held at the raise. */
const removedSinceRaised = (P: Pick<AccountStartPure, 'removalCountKey'>, a: Pick<AccountLedgerForAStart, 'proposalHolds'>, id: Uint8Array): boolean =>
  a.proposalHolds.member(id) && removalsSoFar(P, a) > a.proposalHolds.lookup(id).removals;

/**
 * The secret a replacement must carry: the one whose commitment the vault keeps as its last fully written
 * (`copiesWrittenKey`, which the contract checks `earlier` against), found among `held`. Null when that key is absent
 * or zero (no secret's copies were ever all written, so none is carried).
 */
const earlierOf = (
  V: Pick<VaultStartPure, 'copiesWrittenKey' | 'secretCommitmentOf'>, v: Uint8Array, copies: VaultLedgerForAStart['secretCopies'], held: readonly string[],
): { readonly secret: Hex } | { readonly unheld: true } | null => {
  const key = V.copiesWrittenKey();
  const written = copies.member(key) ? copies.lookup(key) : ZERO;
  if (written.every((b) => b === 0)) return null;
  const secret = held.map((s) => String(s).toLowerCase()).find((s) => HEX32.test(s) && sameBytes(V.secretCommitmentOf(v, fromHex(s)), written));
  return secret === undefined ? { unheld: true } : { secret: secret as Hex };
};

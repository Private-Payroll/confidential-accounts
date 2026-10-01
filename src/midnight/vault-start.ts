/**
 * **WHAT STARTING A VAULT ASKS OF THE CHAIN, AND WHAT THE CHAIN SAYS IS DONE.**
 *
 * A vault takes no money until three things are on the chain, in this order:
 *
 *   1. its company's account has ADOPTED it: a governance round over
 *      `adoptVaultPayload(vault)`, approved at the account's threshold, carried
 *      out by `adopt`;
 *   2. its first NONCE SECRET is set: a run for this vault alone, whose one leaf
 *      is `secretRunDetails(vault, previous, commitment, copiesRoot, count)` at
 *      an amount of nothing, approved at the vault's bar, after which the
 *      vault's `setNonceSecret` asks the account's `approveVaultChange`;
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
 *   · The adoption round's salt is a hash of the vault's address under a domain
 *     of its own. The round's identity is then public as soon as the vault is,
 *     and so is the adoption itself once carried out, so nothing is lost by it,
 *     and any signer's device finds the same round without being told about it.
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

/** How long a secret run raised now stays open for its approvals, in seconds. */
export const SECRET_RUN_OPEN_FOR = 14n * 24n * 3_600n;
/** How far before now a secret run's window opens, so a block a little behind this device's clock is inside it. */
export const SECRET_RUN_OPENS_BEFORE = 600n;

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

export function adoptionRoundOf(P: AccountStartPure, vault: Hex): AdoptionRound {
  const v = vaultBytes(vault);
  const payload = P.adoptVaultPayload(v);
  const salt = sha256(new Uint8Array([...ADOPTION_SALT, ...v]));
  return { vault, payload: toHex(payload), salt: toHex(salt), proposal: toHex(P.proposalIdOf(payload, P.noVault(), salt)) };
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
 * **THE FIRST SECRET RUN FOR A VAULT**, from the secret the company's filed
 * record holds and the readers it is wrapped to. `readers` are the public halves
 * of the signers' records keys; each gets one sealed copy.
 */
export function firstSecretRunOf(
  circuits: { readonly vault: VaultStartPure; readonly account: AccountStartPure },
  input: { readonly vault: Hex; readonly secret: Hex; readonly readers: readonly Hex[] },
): SecretRun {
  const V = circuits.vault;
  const P = circuits.account;
  const v = vaultBytes(input.vault);
  if (typeof input.secret !== 'string' || !HEX32.test(input.secret)) {
    throw new Error('a vault\x27s secret is thirty-two bytes, and this is not one. Nothing was built.');
  }
  const readers = [...new Set(input.readers.map((r) => String(r).toLowerCase()))].sort();
  if (readers.length === 0 || readers.some((r) => !HEX32.test(r))) {
    throw new Error('a secret is sealed to every signer\x27s records key, and none was given that is one. Nothing was built.');
  }
  const secret = fromHex(input.secret);
  const commitment = V.secretCommitmentOf(v, secret);
  const sealed = readers.map((reader) => ({
    reader, parts: sealSecretCopy({ vault: input.vault, secret: input.secret, reader }),
  }));
  const tree = copiesTreeOf(V, commitment, sealed.map((c) => ({ reader: fromHex(c.reader), parts: c.parts })));
  const details = V.secretRunDetails(v, ZERO, commitment, tree.root, tree.count);
  const salt = hkdf(sha256, secret, RUN_SALT, v, 32);
  const nonce = hkdf(sha256, secret, RUN_NONCE, v, 32);
  const leaf = toHex(P.payoutLeaf(details, nonce));
  const asset = NO_ASSET;
  const sum = sumTreeOfLeaves([leaf], [0n], asset);
  return {
    vault: input.vault,
    previous: toHex(ZERO),
    commitment: toHex(commitment),
    copies: sealed.map((c, i) => ({ reader: c.reader, parts: c.parts.map(toHex), path: tree.paths[i]! })),
    copiesRoot: toHex(tree.root),
    count: tree.count,
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

/** The window a secret run raised at `now` (seconds) is given. */
export const secretRunWindowFrom = (now: bigint): { opensAt: bigint; closesAt: bigint } =>
  ({ opensAt: now - SECRET_RUN_OPENS_BEFORE, closesAt: now + SECRET_RUN_OPEN_FOR });

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
  /** A signer was removed since it was raised, so it can never be carried out. */
  readonly stale: boolean;
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
  /** Absent until the secret run is known: the secret is read from the company's record first. */
  readonly secret?: {
    /** The vault holds this run's secret. */
    readonly set: boolean;
    /** The vault holds another secret: this is not a first start. */
    readonly another: boolean;
    /** The approved root of copies on the chain is this run's. */
    readonly rootIsThisRuns: boolean;
    /** The run, when the account holds it under one of its windows. */
    readonly run: (RoundStanding & RoundMadeOf & { readonly opensAt: bigint; readonly closesAt: bigint; readonly inWindow: boolean }) | null;
    /** The run as it would be raised with the window asked about, when one was. */
    readonly raise?: RoundMadeOf & { readonly proposal: Hex; readonly opensAt: bigint; readonly closesAt: bigint };
    /** For each copy, in the run's order, whether the vault holds it. */
    readonly written: readonly boolean[];
    /** The vault takes money: its secret is this one and every copy is written. */
    readonly started: boolean;
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const removalsSoFar = (P: AccountStartPure, a: AccountLedgerForAStart): bigint => {
  const key = P.removalCountKey();
  return a.proposalHolds.member(key) ? a.proposalHolds.lookup(key).removals : 0n;
};

const standingOf = (
  P: AccountStartPure, a: AccountLedgerForAStart, proposal: Hex, bar: bigint, isRun: boolean,
): RoundStanding => {
  const id = fromHex(proposal);
  const open = a.openProposals.member(id);
  if (!open) return { proposal, open, approvals: 0, needed: Number(bar), stale: false };
  const hold = a.proposalHolds.member(id) ? a.proposalHolds.lookup(id) : { needed: bar, removals: removalsSoFar(P, a) };
  const removed = removalsSoFar(P, a) - hold.removals;
  const higher = hold.needed > bar ? hold.needed : bar;
  return {
    proposal, open,
    approvals: Number(a.approvalCounts.member(id) ? a.approvalCounts.lookup(id) : 0n),
    needed: Number(isRun ? higher + removed : higher),
    stale: !isRun && removed !== 0n,
  };
};

/**
 * **HOW FAR A VAULT'S START HAS GOT**, read off the account's and the vault's
 * ledgers as one block holds them. `run` is the first secret run when the
 * company's record of the secret has been read; `now` is in seconds.
 */
export function startStandingOf(
  circuits: { readonly vault: VaultStartPure; readonly account: AccountStartPure },
  input: {
    readonly vault: Hex; readonly account: AccountLedgerForAStart; readonly vaultLedger: VaultLedgerForAStart;
    readonly run?: SecretRun; readonly now: bigint;
    /** A window to make the run's identity with, for a device about to raise it. */
    readonly window?: { readonly opensAt: bigint; readonly closesAt: bigint };
  },
): StartStanding {
  const V = circuits.vault;
  const P = circuits.account;
  const a = input.account;
  const v = vaultBytes(input.vault);
  const adoption = adoptionRoundOf(P, input.vault);
  const adopted = adoptedSetOf(a).member(v);
  const out: StartStanding = {
    adopted,
    adoption: {
      ...standingOf(P, a, adoption.proposal, a.threshold, false),
      payload: adoption.payload, named: toHex(P.noVault()), salt: adoption.salt,
    },
  };
  if (input.run === undefined) return out;
  const run = input.run;
  const commitment = fromHex(run.commitment);
  const onChain = input.vaultLedger.nonceCommitment;
  const set = sameBytes(onChain, commitment);
  const another = !set && onChain.some((b) => b !== 0);
  const rootKey = V.copiesRootKeyOf(commitment);
  const copies = input.vaultLedger.secretCopies;
  const rootIsThisRuns = copies.member(rootKey) && sameBytes(copies.lookup(rootKey), fromHex(run.copiesRoot));
  const written = run.copies.map((c, place) => copies.member(V.copyKeyOf(commitment, fromHex(c.reader), BigInt(place), 0n)));
  const writtenKey = V.copiesWrittenKey();
  const started = set && copies.member(writtenKey) && sameBytes(copies.lookup(writtenKey), commitment);
  const bar = a.thresholds.member(v) ? a.thresholds.lookup(v) : a.threshold;
  let found: NonNullable<StartStanding['secret']>['run'] = null;
  for (const [id, window] of a.runWindow) {
    if (toHex(id) !== secretRunProposalOf(P, run, window)) continue;
    found = {
      ...standingOf(P, a, toHex(id), bar, true),
      payload: payloadOf(P, run, window), named: run.vault, salt: run.salt,
      opensAt: window.opensAt, closesAt: window.closesAt,
      inWindow: window.opensAt <= input.now && input.now < window.closesAt,
    };
    if (found.inWindow) break;
  }
  const raise = input.window === undefined ? {} : {
    raise: {
      proposal: secretRunProposalOf(P, run, input.window), payload: payloadOf(P, run, input.window), named: run.vault,
      salt: run.salt, opensAt: input.window.opensAt, closesAt: input.window.closesAt,
    },
  };
  return { ...out, secret: { set, another, rootIsThisRuns, run: found, written, started, ...raise } };
}

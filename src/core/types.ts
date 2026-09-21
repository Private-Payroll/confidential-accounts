import type { Hex, Sealed } from './crypto.js';
import type { PayoutSeed } from '../midnight/run-keys.js';
import type { Payee } from '../midnight/payee-address.js';
import type { PaymentFacts } from '../midnight/payout-tree.js';
import type { SkipRegister } from '../midnight/run-skips.js';

export type { PayoutSeed };
import type { AssetId } from './assets.js';
import type { AddressSource } from './ledger.js';
import type { WiringName } from './provenance.js';

export type Role = 'admin' | 'approver' | 'initiator' | 'viewer';

/*
 * EVERY AMOUNT IN THIS FILE IS A `bigint`, IN THE ASSET'S SMALLEST UNIT, AND
 * NEVER APPEARS WITHOUT AN ASSET BESIDE IT.
 *
 * Both halves of that sentence are load-bearing and they were both wrong here
 * until today.
 *
 * `number` is wrong for money everywhere — `0.1 + 0.2` is not `0.3`, so totals
 * drift by pennies and the drift gets blamed on us. Here it was worse than
 * wrong: ETH has 18 decimals, and a JavaScript number cannot hold 18
 * significant digits, so an ether amount did not round, it lost value. bigint
 * was chosen over a decimal string on purpose — a string round-trips through
 * JSON for free and then answers `"9" > "10"` and `"100" + "200" === "100200"`,
 * both silently. A bigint compares and adds correctly and cannot be serialised
 * by accident, which is why `canonical`/`parseCanonical` exist.
 *
 * An amount with no asset is not a number, it is a category error: 500000 is
 * five thousand pounds, half a USDC, or a rounding error in ether, and nothing
 * in the value says which. So every field below that carries an amount carries
 * an `AssetId` in the same structure, and there is deliberately no helper
 * anywhere that adds amounts of different assets together.
 */

/**
 * A person, global across accounts. Membership of an account is expressed by a
 * Signer row pointing back here, so one user can belong to several organisations.
 */
export interface User {
  id: string;
  /**
   * NULL FOR A PERSON WHO SIGNED IN WITH THEIR WALLET, and null is the honest
   * spelling of it. `docs/scope-payroll-identity.md` §10 step 1: sign-in first,
   * *nothing about profiles*. Nothing asked this person for an email, so there
   * is no email — not an empty one, which is a value that compares equal to
   * another absence and finds the wrong person.
   *
   * An email arrives, if it ever does, through step 2's disclosure, under §9's
   * source-of-truth rule. Until then anything that identifies people BY email
   * cannot serve a wallet account, and must say so rather than compare blanks.
   */
  email: string | null;
  name: string;
  /*
   * **`authHash` AND `authSalt` ARE DELETED.**
   *
   * They were the server's half of a password: an HMAC of the client-stretched
   * `authKey`, and the salt it was keyed under. `register` was the only writer
   * and `login` the only reader, and both routes are gone in both builds.
   *
   * **A ROW STILL CARRYING THEM IS A ROW NOTHING CAN REACH.** They are not
   * read, so they cannot be compared against, and a password account has no
   * `walletKey` for a sign-in to resolve it by. Said plainly rather than
   * migrated: a store with password accounts in it is now unusable, which is
   * allowed — the store is scaffolding.
   */
  /** The user's signing and wrapping secrets, sealed under a key we cannot derive. */
  keyBundle: Sealed | null;
  /**
   * HOW MANY TIMES THE BUNDLE HAS BEEN REPLACED.
   *
   * The bundle is ciphertext, so a version inside it would be one we cannot
   * read — it lives out here instead, where the only thing it discloses is a
   * count of writes.
   *
   * It exists because the bundle is replaced WHOLE. Two devices signed in, one
   * records a seat and the other creates a company: the second write erased the
   * first, silently, with a `200`, and what it erased was the only value in the
   * file that could not be derived again.
   */
  keyBundleVersion?: number;
  /*
   * **`identityPublicKey` IS DELETED.**
   *
   * The public half of the key a recovery phrase produced, and what made that
   * phrase a way IN rather than merely a way to a set of keys. **Everything
   * that read it is deleted** — the three recovery routes were gated on it —
   * but the field itself was left behind, because `register` could still set
   * it. `register` is now gone, so nothing writes it and nothing reads it:
   * `createFor` set it to `null` and was the only writer left.
   *
   * **A person who has lost access rebuilds their wallet from its twenty-four
   * words and signs in**, which is the whole of recovery here, and it needs
   * nothing stored on this side.
   */
  /**
   * **WHO THIS PERSON IS: A SUBWALLET, HASHED.**
   * `docs/scope-payroll-identity.md` §2, `docs/NEXT.md` PI1 §3.
   *
   * `sha256` of the bech32 address that answered a sign-in — `walletKeyOf` in
   * `store.ts`, which carries the reason the address itself is not here.
   *
   * **ONE ROW PER ADDRESS, AND TWO ADDRESSES ARE NEVER MERGED.** §2: the eleven
   * slots come from one secret, so two of them may be one human — and this
   * platform must not be able to tell, which is the whole point of a slot per
   * employer. Merging two rows because a person said they were the same person
   * would rebuild exactly the link the design exists to destroy.
   *
   * Absent on every account created before wallet sign-in — those are password
   * accounts and have no wallet.
   */
  walletKey?: string | null;
  createdAt: string;
}

/*
 * **THE DEVICE ROW WENT WITH THE ENVELOPE.**
 *
 * A device held a copy of the bundle key so that removing it could take access
 * away. **Nothing on a device holds anything now**: the key that opens a
 * keyring is recomputed from the person's own wallet on whatever machine they
 * are holding, and `keyring.ts` keeps it in memory for the life of the tab and
 * nowhere else. So there is no copy to cut off, and removing a device is
 * revoking its SESSION — which is a different system, still here, and always
 * was the thing that closes the door.
 *
 * The proof that nothing reachable still depended on this is in
 * `docs/reports/PI4a-proof-of-death.md`, written before the deletion.
 */

export interface Signer {
  id: string;
  /**
   * The signer's blinded leaf in the on-chain signer tree.
   *
   * Computed on the signer's own device as commit(signingPublicKey, blinding).
   * The blinding factor never arrives here, which is the whole point: this
   * value identifies nobody and confirms no guess, so publishing it on chain
   * costs the signer nothing. See decision 0003.
   *
   * Null for signers created under an earlier shape.
   */
  leafCommitment: Hex | null;
  /** Links this account membership to a user. Null for seeded or legacy signers. */
  userId: string | null;
  name: string;
  /**
   * A pending signer has accepted an invite and supplied public keys, but no
   * existing signer has re-wrapped the viewing key to them yet. They can see
   * nothing until one does.
   */
  status: 'active' | 'pending';
  /** ed25519, used to authorise proposals */
  signingPublicKey: Hex;
  /** x25519, used to receive the wrapped account viewing key */
  wrappingPublicKey: Hex;
  role: Role;
  /*
   * `blinding` USED TO BE HERE, AND IT WAS TAKEN BACK OUT. Read this before
   * putting anything like it back.
   *
   * Decision 0003 says a signer's blinding factor lives on that signer's own
   * device and nowhere else — it is as precious as their signing key, and
   * whoever holds a blinding plus a leaf holds the mapping from leaf to person
   * that the on-chain blinding exists to destroy.
   *
   * That rule was broken once, for a reason that looked unavoidable: a removal
   * re-seated every surviving signer at a new generation, a survivor's new leaf
   * is `commit((publicKey, generation), blinding)`, and the account cannot
   * compute one without the blinding — so removing somebody would have needed
   * every remaining signer online at that moment. For a removal, which usually
   * happens because somebody left abruptly, that is the worst possible
   * requirement. The blindings were gathered into the sealed roster instead.
   *
   * The need is gone entirely. A signer now occupies a slot, removal clears
   * that one slot, and nobody is re-seated — so no leaf but the departing one
   * ever has to be recomputed, and nothing off the device is needed to do it.
   * The concession is undone rather than merely regretted.
   */
}

/** The viewing key, sealed to one signer. Only that signer can open it. */
export interface WrappedViewingKey extends Sealed {
  signerId: string;
  ephemeral: Hex;
}

export interface SpendingLimit {
  /** null means no per-transaction ceiling */
  perTransaction: bigint | null;
  /** null means no ceiling over the window */
  perPeriod: bigint | null;
  periodDays: number;
}

/**
 * A figure that only means something once you know which asset it is in.
 *
 * KEYED BY ASSET, and it has to be. A ceiling of 5,000 is a sensible monthly
 * payroll limit in pounds and a fortune in ether; one number covering both
 * would either block every legitimate ETH payment or wave through every
 * fraudulent one, depending on which asset the person setting it had in mind.
 * An asset with no entry has no limit of that kind, which is the honest default
 * — a limit nobody set should not be enforced at a number nobody chose.
 */
export type PerAsset<T> = Partial<Record<AssetId, T>>;

/**
 * **EVERYTHING IN HERE IS OURS, AND NONE OF IT IS AUTHORITY.**
 *
 * `threshold` is a COPY. The number that decides whether a round may settle is
 * the contract's, read back through `LedgerStatus.threshold`; this field exists
 * so a screen can render a bar without a round trip and so `sealAccount` has
 * something to write into the readable part of the stored record. **Nothing may
 * decide anything from it.** If the two ever disagree, the chain is right and
 * this is stale — see `evaluatePolicy` in `core/account.ts`.
 *
 * `limitsByRole` is an ADVISORY CEILING THIS SERVICE APPLIES. The contract
 * knows nothing about it. A ceiling here stops us relaying a proposal, which we
 * may always decline to do; it is not a rule a company can hold us to, it is
 * not visible to a signer as a chain fact, and it must never be described as
 * though the chain enforced it.
 *
 * **TWO OTHER FIELDS WERE HERE AND BOTH ARE DELETED.**
 *
 * The first was a per-asset figure below which a payment's approval requirement
 * dropped to one — authority reached by holding the rule instead of the key,
 * because whoever set the number set the real threshold for every payment small
 * enough. Nothing replaces it: the use case (small payments move faster) is
 * built and enforced on chain as a PER-VAULT threshold
 * (`contracts/src/ConfidentialAccount.compact:211`, `thresholdFor` at `:1029`),
 * set by a governed proposal every signer approves.
 * `LedgerStatus.vaultThresholds` is where the number now lives, which is to say
 * on chain and nowhere here.
 *
 * The second was a per-asset figure meaning *"at or above this, the full
 * threshold applies"*. Its only ever effect was to cancel the exception above
 * it, so deleting that one left it expressing nothing — a setting a company
 * could set, believe, and be wrong about. **The argument for deleting rather
 * than redefining it is short:** the meaning on offer was *"above this amount
 * use the account's threshold rather than the vault's lower one"*, which is a
 * rule NOTHING ON CHAIN WOULD ENFORCE. The contract's `thresholdFor` is
 * amount-blind. A product applying it would tell a company that large payments
 * from a fast-moving vault need every signer while the contract went on
 * settling them at the vault's own number — claiming more safety than exists,
 * which is authority reached by holding the rule. An amount-banded threshold is
 * a CONTRACT change and belongs to whoever writes scope 6, not to a field in
 * this type.
 *
 * **Neither name is written here**, and an inverse grep proving that each of
 * the two identifiers appears nowhere under `src/` is still owed by whoever
 * removed them; a tombstone carrying either would be indistinguishable from a
 * survivor to the check and to anyone running it later. The names, the
 * arguments and the deletions are recorded off this tree. A file that ships may
 * carry neither identifier, not even as a tombstone.
 */
export interface Policy {
  /**
   * M of N, as WE last recorded it. Rendered, never decided from.
   *
   * **AND IT IS THE ACCOUNT'S NUMBER ONLY.** There is no per-vault
   * counterpart of this field and there must not be: a vault's threshold is
   * absent-means-inherit on chain, so a stored copy would have to represent
   * "no row" as well as a number, and a copy that got that wrong is a screen
   * telling a company a vault has its own rule when it does not. The exceptions
   * are read from `LedgerStatus.vaultThresholds` at the moment they are shown.
   */
  threshold: number;
  /**
   * OURS. A per-role, per-asset ceiling above which this service declines to
   * relay a proposal at all. Applied here; unknown to the contract.
   */
  limitsByRole: Partial<Record<Role, PerAsset<SpendingLimit>>>;
}

export interface Account {
  id: string;
  name: string;
  signers: Signer[];
  policy: Policy;
  wrappedKeys: WrappedViewingKey[];
  /** Recovery quorum may differ from the signer set. */
  recovery: { signerIds: string[]; threshold: number };
  createdAt: string;
  /**
   * THE COMPANY'S OWN ADDRESS ON THE CHAIN, AND IT IS HERE SO A RE-SEAL CANNOT
   * DROP IT.
   *
   * It is a PUBLIC value and it is not sealed — it is on `SealedAccount`, in
   * the clear, where `threshold` and `signerCount` are and for the same reason.
   * It appears on this type only because `sealAccount` builds the stored record
   * from an opened `Account`: a readable field with no home here is written
   * once at creation and silently dropped by the next `save()`. **The key that
   * opens this company's keyring is derived from this string**, so losing it is
   * losing the data — the same loss, with a smaller radius.
   *
   * Null while the company is not on a chain — see `Ledger.address`.
   */
  contractAddress?: string | null;
  /**
   * WHERE `contractAddress` CAME FROM.
   *
   * Here for the reason `contractAddress` is here and no other: `sealAccount`
   * rebuilds the stored record from an opened `Account`, so a readable field
   * with no home on this type is written once and dropped by the next write.
   */
  addressSource?: AddressSource | null;
  /**
   * Carried across seal and open for the reason `addressSource` is: this record
   * is rebuilt from an opened account on every write, so a readable field that
   * is not copied here is written once and silently gone by the next roster
   * edit. A marker that disappears reads as *not known*, which fails closed but
   * loses a fact that cannot be recovered.
   */
  wiring?: WiringName | null;
}

/**
 * A signer who has accepted an invite and is waiting to be granted access.
 *
 * THIS RECORD IS WRITTEN BY SOMEBODY WHO HOLDS NO VIEWING KEY, and that is the
 * whole reason it exists rather than being a row in the sealed roster. The
 * invitee must see nothing until an existing signer grants them access, so they
 * cannot be handed the key that would let them write themselves into it.
 *
 * So it is a drop box. The public halves — including `leafCommitment` — are
 * sealed to the ACCOUNT'S INBOX public key, whose secret is derived from the
 * viewing key. Anyone may post; only a key holder may read.
 *
 * `leafCommitment` is NOT left in the clear here, and that is a departure from
 * the "public halves only" sketch in the handover, because the obvious design
 * gets it wrong. The leaf is a public value and alone it identifies nobody —
 * but `userId` below points at a `User` row holding a real name and email, so a
 * plaintext leaf beside it reconstructs exactly the leaf-to-person mapping the
 * on-chain blinding exists to prevent (decision 0003). One join is not
 * meaningfully harder than one column, and the rule is that the pairing must
 * not be readable — not that it must not share a row.
 */
export interface PendingSigner {
  id: string;
  /**
   * Outside the envelope, and the same exposure as `memberUserIds`: an opaque id
   * saying this user is waiting on this account. Needed with no key at all, to
   * refuse a second seat to someone who already holds one.
   */
  userId: string | null;
  createdAt: string;
  /** name, role, signingPublicKey, wrappingPublicKey, leafCommitment. */
  sealed: { ephemeral: Hex } & Sealed;
}

/** What a pending signer's drop box holds, once a key holder opens it. */
export interface PendingSignerPayload {
  name: string;
  role: Role;
  signingPublicKey: Hex;
  wrappingPublicKey: Hex;
  leafCommitment: Hex;
  /*
   * No `blinding`. See `Signer` above: one was needed here so a removal could
   * re-seat this person later, and the re-seating is gone, so the invitee's
   * blinding never leaves their device again.
   */
}

/**
 * An account as the SERVER holds it.
 *
 * The company name, every signer's name, role and `leafCommitment`, the spending
 * limits as real money figures and the recovery quorum all live inside `sealed`
 * and nowhere else. There is no field on this type through which any of them
 * could be written in the clear.
 *
 * Six things stay readable, and each is here for a reason that survives being
 * written down:
 *
 * - `id`, `createdAt` — Tier 4. Routing and ordering. They say nothing.
 * - `threshold`, `signerCount` — **already public on chain** (Tier 1). "How many
 *   people may approve, and how many must" is what makes M-of-N auditable, and
 *   the contract publishes both. Repeating them costs nothing and lets the
 *   account picker render before anything is unlocked.
 * - `memberUserIds` — opaque ids, no names, no roles, **no `leafCommitment`**.
 *   The server decides whether a session may touch an account BEFORE any key is
 *   supplied; that is the multi-tenancy check and there is no key at that point.
 *   It reveals that a user is on an account, which the access pattern reveals
 *   anyway, and it does not reveal the pairing the sealing exists for.
 * - `wrappedKeys` — must stay outside regardless: it is how a signer OBTAINS the
 *   viewing key. Sealing it would be a lock with its key inside the box.
 * - `inboxPublicKey` — an x25519 public key. See `PendingSigner`.
 */
export interface SealedAccount {
  id: string;
  createdAt: string;
  /** Which viewing key sealed this. Advances on rotation (K-4). */
  keyEpoch: number;
  /** Public on chain. Written from the sealed policy, which is the one copy. */
  threshold: number;
  /** Public on chain. Written from the sealed roster, which is the one copy. */
  signerCount: number;
  /** Opaque ids of ACTIVE signers who are also users. All `membership` reads. */
  memberUserIds: string[];
  pendingSigners: PendingSigner[];
  wrappedKeys: WrappedViewingKey[];
  /** x25519 public half; the secret is derived from the viewing key. */
  inboxPublicKey: Hex;
  /**
   * TWO envelopes, not one, and under different subkeys.
   *
   * This is the first place the per-purpose subkeys buy anything concrete. A
   * bookkeeper or an accounting plug-in that needs the spending rules can be
   * handed `k_policy` without `k_roster`, and it will read the limits and
   * nothing about who works here. One envelope would have made that impossible
   * without re-sealing every account — which is precisely the cost the subkey
   * decision was taken to avoid.
   */
  /** name, signers[]. */
  sealedRoster: Sealed;
  /** policy, recovery. */
  sealedPolicy: Sealed;
  /**
   * **THE COMPANY'S ACCOUNT CONTRACT ADDRESS. PUBLIC, DURABLE, AND NOT OURS TO
   * CHOOSE.** `docs/scope-payroll-identity.md` §9.
   *
   * Sixty-four lower-case hex characters, or null while this company has no
   * contract. The wallet derives the key that opens this company's records from
   * it and from nothing else, which is what makes a copy of the data openable
   * on another client, on another host, after a recovery — and it is why the
   * value is written from what the ledger reports rather than minted here.
   *
   * **IT IS DURABLE ON PURPOSE.** `SimulatedLedger` holds its whole world in
   * memory and forgets it on restart; a key derived from something that forgets
   * is a key that stops opening yesterday's data. So the address is copied onto
   * the account record the moment the account is opened, and read from here
   * ever after.
   *
   * Optional because every account created before it was recorded has none.
   */
  contractAddress?: string | null;
  /**
   * **WHETHER A CHAIN ASSIGNED THAT ADDRESS, OR THIS PROCESS INVENTED IT.**
   *
   * A simulated address is thirty-two random bytes written as sixty-four
   * lower-case hex characters **precisely because that is the shape of a real
   * one** — so no check downstream can work this out, and the honest refusal
   * for a company with no address could never fire.
   *
   * **ABSENT MEANS NOT KNOWN, AND NOT KNOWN IS TREATED AS NOT A CHAIN'S.**
   * Every account created before this field has none, and there is no way to
   * find out after the fact which kind it was. Reading absence as `'chain'`
   * would make the guard pass for exactly the records it cannot vouch for.
   */
  addressSource?: AddressSource | null;
  /**
   * **WHICH LEDGER WROTE THIS RECORD.** Written once, when the record first
   * appeared, by the ledger that wrote it - never afterwards, and never onto a
   * record whose writing nothing observed.
   *
   * Absent means NOT KNOWN, exactly as it does for the company address, and
   * not known is never read as a chain's. A list refuses to show records from
   * more than one ledger together rather than guess which of them settled.
   */
  wiring?: WiringName | null;
}

/*
 * `'deposit'` STAYS AND `'withdrawal'` STAYS. The account's balance was
 * removed, not its record of what happened — an entry is a line in the
 * account's own log, sealed under the viewing key, and nothing computes a
 * balance from it. Nothing writes `'deposit'` today: the path that did was the
 * account's own deposit, which is gone, and a vault deposit is the vault's
 * record and not this log's. It is kept rather than removed because a log that
 * has ever held one must still be readable, and because the kind an incoming
 * vault movement will be filed under is a decision for whoever builds it.
 */
export type EntryKind = 'deposit' | 'withdrawal' | 'payroll' | 'transfer';

/** A line in the shielded ledger. Never leaves the account unencrypted. */
export interface ShieldedEntry {
  id: string;
  kind: EntryKind;
  /** Which asset moved. An amount without one cannot be read. */
  asset: AssetId;
  /** In `asset`'s smallest unit. */
  amount: bigint;
  counterparty: string;
  memo: string;
  at: string;
  /** Set when the entry belongs to a payroll run. */
  runId?: string;
  /** Set when the entry is readable by a specific outside party (an employee). */
  recipientId?: string;
}

/**
 * WHAT THE ACCOUNT HAS DONE. Not what it holds — it holds nothing.
 *
 * The plaintext behind the on-chain commitments, sealed under the viewing key
 * and never seen by us.
 *
 * `balances: Record<AssetId, bigint>` STOOD BESIDE `entries` AND IS GONE. It
 * mirrored the contract's `assetBalances`, which is also gone: the account is
 * an authority over a vault's money, not a holder of any. Every payment out is
 * recorded on chain in `movements` by `recordPayment`, and the entry log here
 * is the readable account of the same events.
 */
export interface ShieldedState {
  entries: ShieldedEntry[];
}

/**
 * The blinding factors that turn a `ShieldedState` into the commitments on
 * chain. Sealed beside it, and useless without it.
 *
 * SEPARATE FROM THE STATE, deliberately. What lives here is only what cannot be
 * recomputed — a blinding is unrecoverable from the value it hides, which is
 * the whole point of one.
 */
export interface StateBlinding {
  /**
   * The account's asset blinding. Constant for the life of the account.
   *
   * NOT rotated by K-4, and this is the one exception to "rotation re-seals
   * everything". Every change commitment a signer has already approved names
   * its asset as `assetKeyOf(assetId, this)`, so changing it would make a run
   * one signature from settling impossible to present at a vault. Rotation
   * changes who can READ the blinding; it must not change the blinding.
   */
  assetBlinding: Hex;
  /**
   * The secret every payroll run's per-payee nonces and blindings are derived
   * from, one generation per key epoch.
   *
   * **Here rather than on the machine that raises a run**, which is the whole
   * point: a run built on one laptop and payable only from that laptop makes a
   * five-signer account depend on one person being online. This lives in the
   * sealed state every signer can read, so any admin can rebuild a run's leaves
   * exactly and finish a payroll somebody else started.
   *
   * **A LIST, AND OLD GENERATIONS ARE KEPT.** Rotation appends rather than
   * replaces. Runs already approved keep deriving from the seed they were
   * raised under, so removing a signer cannot strand an approved payroll —
   * which would be a new way to lose access to money, introduced by the fix for
   * one. New runs use the newest seed, so a removed signer learns nothing about
   * any payroll raised after they left.
   *
   * Unlike `assetBlinding`, this one IS regenerated by a rotation, and the
   * difference is that nothing on chain is keyed by it.
   */
  payoutSeeds: PayoutSeed[];
}

export type ProposalKind =
  | 'transfer' | 'payroll' | 'add-signer' | 'remove-signer' | 'set-threshold'
  /** One vault's own threshold. Its own kind for the same reason its
   *  payload has its own domain string: it is not a change to the account's. */
  | 'set-vault-threshold'
  | 'change-policy';
/**
 * `cancelled` is distinct from `rejected`: rejected is a judgement about the
 * proposal, cancelled is a round that was withdrawn. It existed because the
 * contract permitted exactly one open proposal at a time, so a single one that
 * would never reach its threshold wedged the account.
 *
 * THAT IS NO LONGER SO: several proposals are open at once and an abandoned one
 * blocks nothing. Withdrawing is still worth having — a stale item should not
 * sit in a queue looking actionable, and its row in the public map should go —
 * which is the same argument the contract's own `cancel` circuit now makes.
 */
export type ProposalStatus = 'open' | 'approved' | 'executed' | 'rejected' | 'blocked' | 'cancelled';

export interface Approval {
  signerId: string;
  signature: Hex;
  at: string;
}

/**
 * **WHY WE COULD NOT GET AN ANSWER OUT OF THE LEDGER.**
 *
 * Three distinct facts, and they are three rather than one because a caller
 * that has to act on them acts differently on each:
 *
 * - `not-yet-proposed` — we have not submitted this round. Known by
 *   construction at propose time, not by asking, and the only one of the three
 *   that is ordinary.
 * - `no-status` — the ledger returned no status for this account at all. Either
 *   the account is not on this ledger or the ledger did not answer.
 * - `not-open` — the ledger answered and this proposal was not among the open
 *   rounds. It has settled, it was cancelled, or it was never accepted.
 */
export type ApprovalUnknown = 'not-yet-proposed' | 'no-status' | 'not-open';

/**
 * **WHAT THE CHAIN SAYS ABOUT ONE APPROVAL ROUND — OR THAT WE DO NOT KNOW.**
 *
 * `satisfied` used to be a boolean this service computed from its own count
 * against its own copy of the threshold, and a boolean cannot hold the third
 * case. **A round nobody can find on chain and a round that lacks approvals are
 * different facts** — the first is our ignorance and the second is the signers'
 * position — and merging them lets a product show "waiting for signatures" when
 * the truth is "we cannot see the chain". This type makes that merge
 * unwritable: there is no boolean to read, and `unknown` carries no counts
 * because we have none.
 *
 * `approvals` and `threshold` are both the LEDGER's, never ours. They are
 * public on chain by design (decision 0003) so carrying them here is not a
 * leak.
 */
export type ApprovalOutcome =
  | { state: 'satisfied'; approvals: number; threshold: number }
  | { state: 'short'; approvals: number; threshold: number }
  | { state: 'unknown'; why: ApprovalUnknown };

export interface Proposal {
  id: string;
  accountId: string;
  /**
   * WHAT THE CHAIN CALLS THIS PROPOSAL.
   *
   * The blinded commitment `commit(digest, salt)` that keys `openProposals` on
   * chain, and the value every approval nullifier is derived from. Distinct
   * from `id`, which is our own routing handle: `id` is how a URL finds this
   * record, this is how the contract finds it, and conflating them would put a
   * database key into a circuit.
   *
   * Readable, and it has to be — a signer's device needs it to approve, and it
   * is already public on chain. It is blinded, so it discloses nothing about
   * the payload.
   */
  chainId: Hex;
  /**
   * **WHICH VAULT THIS ROUND CONCERNS.** `noVault()` where it
   * concerns none, which is every round this product raises today.
   *
   * It decides how many approvals the round needs — `thresholdFor(vault)`,
   * `contracts/src/ConfidentialAccount.compact:1358` — so it is not a label. It
   * is also committed INSIDE `chainId` (`proposalIdOf`, `compact:874`), which
   * is what makes the on-chain APPROVAL NULLIFIER collected for one vault
   * worthless at another: a different id, not a rejected one. **IT WAS NEVER
   * TRUE OF THE SIGNATURE — `approvalMessage` (`account.ts`) is where that
   * binding lives.**
   *
   * **SEALED, NOT READABLE, AND THE CONTRACT MAKES THE SAME CHOICE.** The chain
   * learns the vault only when a payment is recorded against the round
   * (`recordPayment` discloses it, `compact:2639`); at propose time it holds a
   * commitment and nothing more. Which pot of money an OPEN round is reaching
   * into is a live signal about a pending payment — the same reason `propose`
   * refuses to disclose the asset key (`compact:2105`). Every path that needs it
   * already opens the sealed blob to read the amount.
   */
  vault: Hex;
  kind: ProposalKind;
  /** Public: what everyone can see. Amounts live in the sealed part. */
  summary: string;
  /** Sealed under the account viewing key. */
  sealedPayload: Sealed;
  /** Public: the round's CONTENT. Binds kind and payload, NOT the account. */
  digest: Hex;
  proposedBy: string;
  /**
   * **THE SIGNATURES WE HOLD. NOT THE COUNT THAT DECIDES ANYTHING.**
   *
   * These are kept because an approval is a signature over `digest` and we are
   * the ones storing it, and because `approval-signature.test.ts` spends one
   * against another round. `length` used to be the number `satisfied` was
   * computed from; it is not any more, and the two can legitimately differ —
   * the chain counts nullifiers and can hold an approval we never recorded, or
   * refuse one we did.
   */
  approvals: Approval[];
  status: ProposalStatus;
  /**
   * **WHAT THE LEDGER SAID ABOUT THIS ROUND, LAST TIME WE ASKED.**
   *
   * Undefined on a proposal nothing has asked about yet. Written by `approve`
   * from a single `status()` read taken after the ledger accepted the approval,
   * and it is what keeps *"we do not know"* distinguishable from *"not enough
   * approvals"* after the call returns: `status` alone cannot tell them apart,
   * because both leave it `open`.
   *
   * Sealed with the rest of the proposal body. Its contents are public on chain
   * anyway; sealing costs nothing and keeps the readable record to what routes
   * and filters.
   */
  approvalRound?: ApprovalOutcome;
  /** Why OUR OWN ceiling stopped it being relayed, if one did. */
  blockedReason?: string;
  createdAt: string;
  executedAt?: string;
  /** Reference returned by the ledger on settlement. */
  txRef?: string;
}

/** A person on the payroll, held at account level rather than inside a run. */
/**
 * A proposal as the SERVER holds it.
 *
 * The sharpest item in this whole exercise is `approvals[].signerId`. The chain
 * records approvals as NULLIFIERS precisely so that nobody — including us — can
 * tell which signer approved what; that is decision 0003. Our own table held
 * the deanonymised version of exactly that, next to a human-written summary
 * that will contain names and amounts.
 *
 * Outside the envelope: an id and an account to route on, a status to filter on,
 * a digest that is already a hash, and the txRef, which is public on chain
 * anyway. Everything that says WHO or WHAT or HOW MUCH goes inside.
 */
export interface SealedProposal {
  id: string;
  accountId: string;
  status: ProposalStatus;
  createdAt: string;
  executedAt?: string;
  /** Already a hash, and what the chain's own commitment is taken over. */
  digest: Hex;
  /** The blinded id the contract knows this proposal by. */
  chainId: Hex;
  /** Public on chain the moment it settles. */
  txRef?: string;
  /** How many approvals, without saying whose. Mirrors the chain's own count. */
  approvalCount: number;
  keyEpoch: number;
  /** kind, summary, sealedPayload, proposedBy, approvals[], blockedReason. */
  sealed: Sealed;
  /**
   * **WHICH LEDGER WROTE THIS RECORD.** Written once, when the record first
   * appeared, by the ledger that wrote it - never afterwards, and never onto a
   * record whose writing nothing observed.
   *
   * Absent means NOT KNOWN, exactly as it does for the company address, and
   * not known is never read as a chain's. A list refuses to show records from
   * more than one ledger together rather than guess which of them settled.
   */
  wiring?: WiringName | null;
}

export interface RosterEmployee {
  id: string;
  accountId: string;
  name: string;
  /**
   * **NULL FOR SOMEBODY WHO IS NOT IDENTIFIED BY AN EMAIL AT ALL.**
   * `docs/how-money-can-be-lost.md` `C153`.
   *
   * This was a required `string`, and a wallet sign-in has no email — so making
   * a wallet-signed-in founder payable meant either refusing — which is what
   * happened — or **writing an empty string into it, which a test now pins
   * against**: a blank compares equal to every other blank, so the
   * one-payable-entry-per-person cap in `admit` would read two different people
   * as one person and the same person as somebody else. **A cap that inverts
   * means one person paid twice.**
   *
   * So it is `null`, and null has exactly one meaning: *nothing ever asked this
   * person for an email, so the record does not carry one.* It never means *we
   * lost it* and never means *empty*. `User.email` is null for the same reason
   * and says the same thing.
   *
   * **AND A NULL HERE CAN ONLY COME FROM ONE DOOR.** An invitation is addressed
   * to somebody, so `invite` refuses a spec without an email; the only path
   * that writes null is `addSelfAsPayee`, where the caller and the payee are
   * the same person by construction. Who the record is about is then the
   * sign-in that set the address — `handedOverBy` — which `admit` is what caps.
   */
  email: string | null;
  title: string;
  /**
   * WHAT THEY ARE PAID IN. One asset, and there is deliberately no second one.
   *
   * An earlier version of this had `denomination` — what the contract of
   * employment says — beside `settlementAsset`, what actually moves, so that a
   * person hired at $5,000 could be paid in USDC at a recorded rate. **That was
   * ruled out: everybody is paid in the currency they are assigned here, and
   * there are no exchange rates in this product.**
   *
   * Keeping both fields under that rule would have been strictly worse than
   * having one. They would be required to be equal, so every read would need to
   * decide which to trust, every write would need to keep them in step, and the
   * first time they disagreed the system would have to invent a rate to
   * reconcile them — which is exactly the thing being ruled out. Two fields that
   * must always be equal is one field and a bug waiting to be written.
   *
   * What is lost, and it is worth knowing rather than discovering: if somebody
   * is hired "at $5,000 a month" and paid in USDC, this records 5,000 USDC and
   * does not remember the dollar figure. That is fine while it stays a hiring
   * conversation. If it ever needs to be on the record it should be a free-text
   * note nothing computes from — NOT a second currency field, which drags
   * exchange rates back in through the side door.
   */
  asset: AssetId;
  /** Monthly gross, in `asset`'s smallest unit. £5,000.00 is `500000n`. */
  baseAmount: bigint;
  startDate: string;
  /** Pending means they have not generated a key yet, so nothing can be sealed to them. */
  status: 'active' | 'pending' | 'leaver';
  /** Null until the employee's own device generates one and sends the public half. */
  wrappingPublicKey: Hex | null;
  /**
   * WHO HANDED THE ADDRESS OVER, AND WHO ACCEPTED IT ONTO THE ROSTER.
   *
   * Sealed with the rest, and recorded because **`admit` is the moment the
   * address of record is set** and it used to leave no trace of itself at all.
   * The skip register already carries an author, a time and a reason for a
   * decision not to pay somebody; deciding WHERE to pay them deserves the same.
   */
  handedOverBy: string | null;
  admittedBy: string | null;
  admittedAt: string | null;
  /**
   * The person who raised this invite is the person who redeemed it.
   *
   * **A FACT, NOT A REFUSAL.** `admit` used to throw on this. Refusing asked
   * about the wrong person — the raiser — when the question that matters is
   * whether the redeemer is the PAYEE, which the email check answers directly.
   * The price of that refusal was a second flow so founders could get on their
   * own payroll, and that flow became a hole of its own. Recorded instead, so
   * an admin reviewing a roster can see it.
   */
  selfRaised: boolean;
  /**
   * WHERE THEIR MONEY GOES, and it is the reason identity was sequenced ahead
   * of the chain work.
   *
   * One value carrying both keys — who may spend, and who may ever SEE the
   * payment. It is **produced by the employee's own device or their own wallet**
   * and handed over through the account's drop box; there is nowhere in this
   * product for an operator to type one, and that absence is the feature.
   *
   * Null until they have handed one over. **Null is not payable**: an address
   * on file is not the same as somebody who can reach what is sent to it, and a
   * payment settles irreversibly the moment it lands.
   *
   * INSIDE the sealed envelope, unlike `wrappingPublicKey`. Both are public
   * values, so neither is a secret on its own — but this one says which
   * on-chain identity a given company pays, which the chain itself does not
   * reveal, because the payments are shielded. Putting it outside would give
   * our database a fact the ledger deliberately does not have.
   *
   * **`Payee` AND NOT `PayeeAddress`, AND THE WIDENING IS DELIBERATE.** The
   * roster records whichever kind of address a person's own wallet produced,
   * because `payeeOf` reads the kind off the string and there is nothing to ask
   * anybody. **It does NOT follow that anybody can be paid publicly from a
   * run**: `payrollPayee` in `movement.ts` refuses a public payee on the
   * payroll path, so the widening is a door and the refusal is a separate rule
   * sitting behind it. `paymentFactsFor` still returns `ShieldedPaymentFacts`,
   * and it is that refusal which keeps it true.
   */
  address: Payee | null;
}

/**
 * An invitation to join an account. Carries no secret: the invitee generates
 * their own keys and sends back only public halves.
 */
/**
 * A roster entry as the SERVER holds it.
 *
 * The name, email, title and salary live inside `sealed` and nowhere else, so
 * there is no field on this type through which a salary could be written in the
 * clear. That is the point: the fix is a shape, not a habit.
 *
 * Two fields stay readable and both are deliberate. `id` is how a record is
 * addressed. `accountId` is how it is found without opening every record in the
 * database — it reveals that a company has employees and roughly how many,
 * which is metadata we already expose through blob counts and cannot remove
 * while we host at all (see the access-pattern note in the scope document).
 */
export interface SealedEmployee {
  id: string;
  accountId: string;
  /**
   * THE DROP BOX. A-2, and the same construction as a pending signer's.
   *
   * The employee has no viewing key and must never have one, so they cannot
   * write into the sealed roster themselves. They post here instead — sealed to
   * a public key whose secret only a viewing-key holder can derive — and an
   * admin folds it in and empties the box, so there is never a second copy.
   *
   * Null when there is nothing waiting.
   */
  inbox: (({ ephemeral: Hex } & Sealed) | null);
  /**
   * Outside the envelope on purpose, and it is a public key: alone it says
   * nothing about who anyone is.
   *
   * It has to be outside because the EMPLOYEE writes it when they accept their
   * invite, and the employee does not hold the company's viewing key — they
   * must not. A design that required it would either hand the company's key to
   * every employee or make the company complete the step on their behalf.
   */
  wrappingPublicKey: Hex | null;
  /** Operational, and needed to filter a run without opening every record. */
  status: 'active' | 'pending' | 'leaver';
  /** Which viewing key sealed this. Advances on rotation (K-4). */
  keyEpoch: number;
  /** name, email, title, salary, currency, startDate. Nothing else. */
  sealed: Sealed;
}

export interface Invite {
  /**
   * **THE HASH OF THE TOKEN, NOT THE TOKEN.**
   *
   * This used to be the credential itself, sitting in a table any database
   * backup carries. Every audit of this flow has circled the same fact: an
   * invite is a bearer credential, and we were storing spendable copies of all
   * of them. Sessions already learned this — `tokenHash` in `sessions.ts`, with
   * the same reasoning: *"a hash, so the stored value is useless if the table
   * leaks."*
   *
   * **The half of this that is true, and only that half, may be counted:**
   * nobody who takes the DATABASE can produce a usable invite, or read the offer
   * sealed under the raw token.
   *
   * An earlier version of this said the raw token exists only in the message
   * sent to the person it is for. It does not — the delivery port holds every
   * token it has been given, in memory, for the life of the process, with the
   * name and email beside it. That is a real retention and it is not
   * this field's. **And since the offer is sealed to it, a retained token is no
   * longer just a bearer credential: it is the key to a salary.**
   */
  token: string;
  accountId: string;
  kind: 'signer' | 'employee';
  /**
   * Signer invites still carry a name and email, because there is no sealed
   * record to point at until the person exists.
   *
   * EMPLOYEE invites carry neither, and must not. They used to duplicate the
   * name, email, title and salary already held on the roster entry — so sealing
   * the roster while leaving this alone would have moved the leak into the
   * invites table rather than closing it, and left two copies of a salary that
   * could disagree.
   */
  name?: string;
  email?: string;
  /** signer invites */
  role?: Role;
  createdAt: string;
  /**
   * WHO MINTED THIS TOKEN.
   *
   * An invite is a bearer token, and there is no mailer in this product — the
   * operator who creates one delivers it by hand, so they see it. That cannot
   * be designed away. What can be is the operator ALSO being the one who
   * redeems it, which is how somebody else's salary comes to be paid to an
   * address the operator controls, with the owner's only signal being "invite
   * already used".
   *
   * Null for invites created before this existed, and for a seeded one.
   */
  createdBy?: string | null;
  /**
   * **WHEN THIS OFFER STOPS BEING ONE.**
   * `docs/scope-invitations.md` §8 and §9.
   *
   * *"An offer that never expires is a salary waiting for whoever eventually
   * finds that link."* Every invitation has one, and §9 refuses an invitation
   * without one by name — so this is optional only in the sense that invites
   * written before this field existed do not carry it, and those are REFUSED
   * where they are read rather than treated as unlimited. Absent is not
   * forever; absent is unreadable.
   *
   * It is beside the sealed offer rather than inside it because the service
   * has to enforce it and cannot open that envelope — the offer is sealed to
   * the raw token, which only the invitee holds. A deadline nobody but the
   * invitee can read is a deadline only the invitee enforces.
   */
  expiresAt?: string;
  /**
   * **WHEN IT WAS TAKEN BACK.** `docs/scope-invitations.md` §8.
   *
   * A hire falls through after the link has been sent, and until this there was
   * no way to take it back: the link kept working, and whoever held it could
   * still set the address a salary is paid to. Set once, by an admin, from the
   * row the invitation is about.
   */
  revokedAt?: string;
  acceptedAt?: string;
  /*
   * `acceptedBy` USED TO BE HERE AND WAS A LEAK.
   *
   * An invite carries `accountId` in the clear — it has to, to be found.
   * Putting the redeeming USER beside it meant one join from `users.name` and
   * `users.email` to "this named person is paid by this company", which is
   * precisely the mapping sealing the roster was meant to destroy. It leaked
   * the moment employees got sign-ins of their own, which is the same week they
   * got them.
   *
   * Who redeemed it is sealed INSIDE the drop box instead, where the rest of the
   * handover already lives, and lands in the sealed roster entry as
   * `handedOverBy` when an admin admits it.
   */
  /** The roster entry this points at. The one copy of everything private. */
  subjectId?: string;
  /**
   * WHAT THE PERSON IS BEING OFFERED, SEALED TO THE TOKEN ITSELF.
   *
   * An invitee cannot read the roster — it is sealed under the company's viewing
   * key and they must never hold one. So they had nothing to look at before
   * handing over the address their salary would be paid to, which is the wrong
   * way round: **you should see what you are accepting before you accept it.**
   *
   * Sealing it under a key derived from the RAW TOKEN solves that without
   * putting a salary in a readable table. Only somebody holding the token — the
   * person it was sent to — can open it. **We hold only the hash, so we
   * cannot**, which is what keeps the property true: the salary is no more
   * readable here than it is on the roster.
   *
   * Emptied when the invite is redeemed, so it is not a second standing copy.
   */
  offer?: Sealed | null;
}

/* ---------------- extension layer ---------------- */

export type Scope =
  | 'state:read'
  | 'state:read:totals'
  | 'people:read'
  | 'runs:read'
  | 'proposal:create'
  | 'disclosure:issue';

export type PluginCategory =
  | 'offramp' | 'treasury' | 'interop' | 'compliance' | 'accounting' | 'identity';

export interface PluginManifest {
  id: string;
  name: string;
  publisher: string;
  category: PluginCategory;
  /** first-party is built by us, verified is a named company, community is neither. */
  verification: 'first-party' | 'verified' | 'community';
  version: string;
  summary: string;
  scopes: Scope[];
  requestsSpend: boolean;
}

export interface Installation {
  id: string;
  accountId: string;
  pluginId: string;
  grantedScopes: Scope[];
  /**
   * Null when the plug-in cannot propose spending at all.
   *
   * A CEILING PER ASSET, in one installation.
   *
   * The property that has to hold is that a limit and the spend it governs are
   * in the SAME currency — an allowance of 1,000 means a sensible weekly limit
   * in pounds and roughly nothing in ether, and the plug-in must not be the one
   * that decides which. A map keyed by asset gives that by construction: the
   * ceiling is looked up by the asset being spent, so there is no pairing to
   * get wrong.
   *
   * The first version of this made an installation single-asset and said a
   * plug-in needing two should be installed twice. That bought the same safety
   * and charged for it twice over — two capability tokens, two audit trails,
   * two things to revoke, and a plug-in having to know which token to use for
   * which currency. That design was rejected.
   *
   * AN ASSET WITH NO ENTRY CANNOT BE SPENT AT ALL. That is the honest default
   * and the reason this is a map rather than a map with a fallback: a limit
   * nobody set is not a limit of zero and not a limit of infinity, it is an
   * asset this plug-in was never granted.
   */
  allowance: {
    limits: PerAsset<{ perProposal: bigint; perPeriod: bigint }>;
    periodDays: number;
  } | null;
  status: 'active' | 'suspended' | 'removed';
  installedAt: string;
  installedBy: string;
  /** Capability token. Bound to one account and one scope set. Not a viewing key. */
  token: string;
}

/** Every plug-in action, allowed or refused. Refusals are the interesting ones. */
export interface PluginEvent {
  id: string;
  installationId: string;
  accountId: string;
  pluginId: string;
  action: string;
  detail: string;
  allowed: boolean;
  /** Present together or not at all. An amount with no asset cannot be read. */
  asset?: AssetId;
  amount?: bigint;
  at: string;
}

export interface Employee {
  id: string;
  name: string;
  /** Employees hold their own key so their line item is readable only by them. */
  wrappingPublicKey: Hex;
  /** What actually moves for this person on this run, and in what. */
  asset: AssetId;
  amount: bigint;
}

export interface PayrollRun {
  id: string;
  accountId: string;
  period: string;
  employees: Employee[];
  /**
   * Per-employee payslips. Two layers: the slip is sealed under a fresh symmetric
   * key, and that key is wrapped to the employee's x25519 public key. Nobody else
   * holds it, including the account signers.
   */
  payslips: Array<{
    employeeId: string;
    wrapped: { ephemeral: Hex } & Sealed;
    slip: Sealed;
  }>;
  /**
   * A SUBTOTAL PER ASSET, never one total, and that is a correctness change
   * rather than a presentation one.
   *
   * `total: number` was the sum of every line on the run. Across mixed
   * currencies that is a number with no unit — adding 5,000 GBP to 5,000 USDC
   * and displaying 10,000 is not an approximation, it is meaningless, and the
   * sufficiency check that used it ("does the account hold enough") would pass
   * or fail for reasons unrelated to whether it does.
   *
   * There is deliberately no helper anywhere that collapses this into one
   * figure. The moment one exists, something will render it.
   */
  totals: Record<AssetId, bigint>;
  status: 'draft' | 'proposed' | 'settled';
  /**
   * One proposal per settlement asset, because a proposal's change commitment
   * names ONE asset key and `execute`, which moved one balance per round, was
   * what made that a settlement rule. It was deleted, so nothing on chain opens
   * the change commitment and nothing refuses a mixed round at that layer; the
   * refusal that is left is the application's, in `AccountService.oneAssetOf`.
   * A single-currency run has one entry, which is every run today; a run paying
   * in dollars and pounds has two.
   */
  proposalIds: Record<AssetId, string>;
  /**
   * **WHAT EACH LEG OF THIS RUN WAS RAISED AGAINST, KEPT SO IT CAN BE PAID AND
   * REPORTED ON.**
   *
   * Absent until a leg is proposed, and absent for ever on a run that was raised
   * before the product could build any — which is why every reader handles the
   * absence rather than assuming a shape.
   *
   * **PER SETTLEMENT ASSET, NOT PER RUN, AND THAT IS NOT A DETAIL.** A root, a
   * leaf count, a window and a vault are properties of ONE APPROVAL, and a run
   * that pays some people in pounds and some in dollars is two approvals over
   * two trees. Held per run, the second leg would overwrite the first, and a
   * payment view built from what survived would report every payee of that leg
   * paid and call the run complete while nobody in the other leg had their
   * money.
   */
  payout?: Record<AssetId, RunPayout>;
  /**
   * **WHO THIS RUN LEFT OUT ON PURPOSE, AND ON WHOSE SAY-SO.**
   *
   * Absent when nobody was, which is every run drawn from a roster on which
   * nobody is pending. **Absent is not the same as an empty record** and
   * nothing writes one: a run that left nobody out has no decision to attribute,
   * and an empty register would be a person's name against nothing.
   *
   * **INSIDE THE ENVELOPE, because it is a list of this company's people and
   * what it says about each of them is that they did not get paid this month.**
   * That is the staff list's kind of fact, and `run-skips.ts` seals its own
   * register under the same `payroll` purpose key for the same reason.
   *
   * **AND IT IS NOT THE INDEX `runStatus` READS, WHICH IS SAID HERE BECAUSE
   * THE TYPE IS THE SAME AND THE INDEX BASIS IS NOT.** `RunInputs.skips` is
   * indexed over a leg's PAYOUT LEAVES and identified by the proposal id the
   * leg was raised under. This one is indexed over `RunSkips.people` — persons
   * who have no leaf, because a run cannot pay somebody it has no address for —
   * and identified by the run's own id. **Handing this one to `runStatus` is
   * refused rather than misread**: `registerFor` compares both the identity and
   * the count, and neither matches. Joining the two up is scheduled elsewhere, and
   * this change does not do it.
   */
  skips?: RunSkips;
  settledAt?: string;
}

/**
 * **ONE PERSON A RUN DID NOT PAY, AND WHICH OF THE TWO REASONS IT WAS.**
 *
 * The name is frozen here rather than looked up later, and that is the same
 * argument `RunPayout.leaves` is kept for: the roster moves. Somebody admitted
 * next week, renamed, or withdrawn would be reported under whatever their row
 * says at reading time, and a report about a payday is about who was left out
 * THAT day.
 */
export interface RunSkip {
  employeeId: string;
  name: string;
  /**
   * **TWO STATES, NAMED SEPARATELY AND NEVER MERGED.** "outstanding" that
   * covers two different situations is how an operator stops looking.
   *
   *   `them`  they have handed nothing over — the invitation is with them
   *   `us`    their drop box is full and an admin has not admitted them
   *
   * **The second is ours to fix and the first is not**, so collapsing them
   * turns a queue an admin can clear into a queue an admin waits on.
   */
  waiting: 'them' | 'us';
}

/**
 * **THE RUN'S SKIP RECORD: THE PEOPLE, AND THE DECISION LOG OVER THEM.**
 *
 * **THE PAIR IS ONE FIELD BECAUSE EITHER HALF ALONE IS UNREADABLE.** A
 * `SkipDecision` carries an INDEX and no name — deliberately, because indices
 * are what a payout tree is addressed by — so the log says who only against a
 * frozen list. Stored apart, a reader that found one without the other would
 * have either names with no attribution or attributions with no names, and the
 * second reads like a record while saying nothing.
 */
export interface RunSkips {
  /** The people left out, in the order `decisions` indexes them. Never reordered. */
  people: RunSkip[];
  /** `run-skips.ts`'s own append-only log. Indices are into `people`. */
  decisions: SkipRegister;
}

/**
 * **ONE APPROVED LEG'S PAYOUT MATERIAL.**
 *
 * The first five fields are exactly what the chain was asked to open the run
 * with, and they are kept because nothing can recover them: what the chain holds
 * is a hash of them. The last three are what makes the leg payable again from
 * another machine.
 */
export interface RunPayout {
  /** The merkle root over this leg's payout leaves. What the signers approved. */
  root: Hex;
  /** How many leaves. Bound into the payload beside the root. */
  payees: bigint;
  /** Seconds since the Unix epoch, because block time is compared against it. */
  opensAt: bigint;
  closesAt: bigint;
  /** The vault that will pay this leg. Folded into the proposal's identity. */
  vault: Hex;
  /**
   * The leaves, in tree order.
   *
   * Inside the sealed envelope, and the reason is stronger than *they are not
   * secret to the company*. The account's record of completed payments is public
   * and append-only, and membership in it is a derivation of the leaf — so
   * anybody holding this list can read off which of these people have been paid,
   * and when, without any key of ours. Outside the envelope our own store would
   * be handing that over.
   */
  leaves: Hex[];
  /**
   * **WHO THIS LEG PAYS, WHAT IN, AND HOW MUCH — AS IT WAS WHEN THE SIGNERS
   * APPROVED IT.**
   *
   * A leaf proves membership; it does not say who to pay. The vault is handed
   * the recipient, the token and the amount and re-derives the leaf from them,
   * so paying an approved run needs these three per payee — and needs them
   * UNCHANGED.
   *
   * **THEY ARE STORED RATHER THAN RE-READ OFF THE ROSTER, AND THE ROSTER IS WHY.**
   * A roster is a live thing: somebody is marked a leaver, a salary is
   * corrected, an address is re-registered. Any of those between the approval
   * and the payment would derive different leaves for a root that is already
   * signed — every payment refused, with nothing naming the cause — and marking
   * one person a leaver would block the rebuild of the whole leg. What the
   * signers approved does not change afterwards, so neither does this.
   */
  facts: PaymentFacts[];
  /**
   * The identifier this leg's per-payee secrets were derived from.
   *
   * **STORED RATHER THAN RECOMPUTED FROM THE RUN AND THE ASSET.** The rule that
   * composes it can be changed by somebody who does not know that changing it
   * strands every approved run that has not been paid yet; the value cannot.
   */
  runId: string;
  /**
   * Which generation of the account's payout seed this leg was raised under.
   *
   * **THE ONE FIELD WHOSE ABSENCE IS SILENT AND FATAL.** Seeds are appended, not
   * replaced, when a signer is removed, so a rebuild that asks for *the current
   * generation* instead of this one derives different secrets, different leaves
   * and a different root — and every payment of an already-approved run is then
   * refused as *"that payee is not in the approved run"*, with nothing naming the
   * cause. Keeping this number is what lets a removal be immediate for future
   * payrolls without reaching back and breaking an approved one.
   */
  epoch: number;
}

/** What an auditor receives. Proves a statement without carrying the underlying data. */
/**
 * A payroll run as the SERVER holds it.
 *
 * Sealing the roster closed one table and left this one open: `employees[]` and
 * `total` are a SECOND copy of the same salaries, written when a run is created.
 * A claim that we cannot read anyone's pay is only true once both are sealed.
 *
 * `payslips` stay outside the envelope because they are already ciphertext,
 * each sealed to one employee's own key — and deliberately NOT readable with
 * the account viewing key, so that an employer cannot open an individual slip.
 * Wrapping them again would add nothing and would hide that property.
 */
export interface SealedRun {
  id: string;
  accountId: string;
  /** Operational: needed to find a run and to refuse a duplicate period. */
  period: string;
  status: 'draft' | 'proposed' | 'settled';
  /**
   * Outside the envelope because a proposal id is already an opaque routing
   * handle and the proposal it points at is sealed. What is NOT outside is the
   * asset each leg is in — the map is sealed with the numbers, so the store
   * cannot see that this company pays anyone in ether.
   */
  proposalIds?: string[];
  settledAt?: string;
  payslips: PayrollRun['payslips'];
  keyEpoch: number;
  /** employees[], totals and the per-asset proposal map. The numbers. */
  sealed: Sealed;
  /**
   * **WHICH LEDGER WROTE THIS RECORD.** Written once, when the record first
   * appeared, by the ledger that wrote it - never afterwards, and never onto a
   * record whose writing nothing observed.
   *
   * Absent means NOT KNOWN, exactly as it does for the company address, and
   * not known is never read as a chain's. A list refuses to show records from
   * more than one ledger together rather than guess which of them settled.
   */
  wiring?: WiringName | null;
}

export interface Attestation {
  id: string;
  accountId: string;
  circuit: string;
  statement: string;
  publicInputs: Record<string, unknown>;
  proof: Hex;
  issuedAt: string;
  expiresAt: string;
}

/**
 * **WHAT WAS REFUSED AT THIS ROUND'S DOOR, KEPT.**
 *
 * ── THE ROW THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * An approval signature is bound to the round it approves, so a signature made
 * for round A no longer verifies against round B. **That makes a replay FAIL.
 * It does not make one VISIBLE**, and a rejected approval that leaves nothing
 * behind is an investigation with no evidence: the only durable record of who
 * consented is `Proposal.approvals`, and a refused attempt never reaches it.
 *
 * **WHAT ONE ENTRY IS, AND WHAT IT DELIBERATELY IS NOT.** The seat that was
 * named, the moment, and — where the submitted bytes are a signature already
 * STANDING on another round of this same account — the `chainId` of that
 * round. **The signature bytes themselves are NOT stored here.** They are
 * already stored, once, on the round they legitimately approve
 * (`Approval.signature`), and a second copy would be a second thing to keep
 * safe for no new fact: ed25519 is deterministic, so equality of the bytes is
 * the whole of the evidence and `replayOf` records the conclusion rather than
 * the material.
 *
 * **`replayOf` IS PROOF AND ITS ABSENCE IS NOT AN ACQUITTAL.** Present, it says
 * these exact bytes are the consent this signer gave to a DIFFERENT round of
 * this account, which is a replay and nothing else. Absent, it says only that
 * the comparison found nothing — an ordinary wrong key, a stale client, or a
 * replay whose source round was CANCELLED, because `cancel` clears `approvals`
 * (`src/core/account.ts`, `cancel`) and takes the evidence with it. **That last
 * case is a known gap and this record cannot close it**; closing it needs a
 * per-account index of signature digests that survives cancellation, which is a
 * new sealed artefact re-creating exactly the approval history `cancel` erases
 * on purpose.
 *
 * **BOUNDED, BECAUSE A MEMBER CAN CAUSE THESE — AND BOTH FIELDS ARE BOUNDED,
 * WHICH THIS SENTENCE USED TO DENY.** It said *`count` is every attempt ever
 * refused against this round*, and that is FALSE at source: `refuseApproval`
 * returns at `REFUSED_APPROVALS_KEPT` without writing, and the increment sits
 * past that return, so **`count` freezes with `recent` at
 * `REFUSED_APPROVALS_KEPT`.**
 *
 * **SO `count` IS ATTEMPTS RECORDED, NEVER ATTEMPTS MADE**, and a reader of
 * this record who needs *made* has to read `logs/REPORT-REFUSALS.txt`, which
 * receives every one of them. A refused approval below the cap costs one
 * durable write, the same cost an accepted one already carries; above the cap
 * it costs none, and the refusal returned says so in words rather than leaving
 * a full list to read as a complete one.
 *
 * **SEALED, LIKE THE APPROVALS IT SITS BESIDE.** `putProposal` seals every
 * field it does not name explicitly, and this one is not named, so `signerId`
 * here is under the account viewing key exactly as `Approval.signerId` is — the
 * same sealing reason, unchanged: a seat id beside a round is the deanonymised
 * form of the chain's nullifiers. **No new key, no new blast radius.**
 */
export interface RefusedApproval {
  /** The seat the request named. Not proof the holder of that seat sent it. */
  signerId: string;
  at: string;
  /**
   * The `chainId` of the round these exact bytes are a standing approval of.
   * Set only when the comparison found one; see the note above on what its
   * absence does and does not mean.
   */
  replayOf?: Hex;
}

/**
 * **DECLARATION-MERGED ONTO `Proposal` RATHER THAN WRITTEN INSIDE IT, AND THE
 * CITATIONS ARE THE WHOLE REASON.**
 *
 * `Proposal` begins at `:599` and this file is cited by `file:line` from six
 * places below that point, three of them in files a change like this may not
 * touch. A field added at `:654` moves every one of them. Appending below the
 * last line moves nothing, and TypeScript merges two `interface Proposal`
 * declarations in one module into one type. **The cost is that a reader of the
 * interface at `:599` does not see this field, which is why this block says so
 * out loud instead of relying on the reader finding it.**
 */
export interface Proposal {
  /**
   * **REFUSED APPROVAL ATTEMPTS AGAINST THIS ROUND.** Undefined until
   * the first one, so an untouched round carries nothing rather than an empty
   * shape that reads like a checked-and-clean result.
   */
  refusedApprovals?: { count: number; recent: RefusedApproval[] };
  /**
   * **WHEN THIS SERVICE ESTABLISHED THAT THE ROUND IS ON CHAIN.**
   * The ledger's own `TxRef.at` when the propose call returned;
   * the moment of the read when a later `confirmRaised` found the round in
   * `openProposals` instead.
   *
   * **UNDEFINED MEANS *NOT CONFIRMED*, NOT *NOT RAISED*, AND THE DIFFERENCE IS
   * THE WHOLE POINT.** The durable record is now written BEFORE the chain call
   * (`AccountService.raise`), because it is the half that cannot be rebuilt —
   * the salt is 32 bytes of fresh randomness and the payload is sealed with a
   * key the caller supplied for that one call, while a chain round can be
   * raised again for another fee. So a record with no `raisedAt` is either a
   * round the chain refused, or one it accepted and whose answer was lost, and
   * only the chain can say which. `approve` and `cancel` ask it.
   *
   * **A PROPOSAL WRITTEN BEFORE THIS FIELD HAS NONE**, and self-heals the first
   * time either door touches it: the round is still in `openProposals` if it is
   * still open, which is the only state in which it matters.
   */
  raisedAt?: string;
  /**
   * **THE ROLE THIS ROUND'S CEILING IS EVALUATED AGAINST, WRITTEN DOWN WHERE
   * REMOVING THE PROPOSER CANNOT TAKE IT AWAY.**
   *
   * `evaluatePolicy` is given the PROPOSER's role, and the only place that role
   * used to exist was the live `signers` row — which
   * `AccountService.removeSigner` DELETES rather than marks, with nothing
   * closing that proposer's still-open rounds. **So an ordinary governed
   * removal, followed by an ordinary approval, made the reconcile read
   * `undefined.role`**; the approval was already durable by then, and the retry
   * repeated the same throw for ever.
   *
   * **IT IS THE ROLE AT PROPOSE TIME AND THAT IS THE CORRECT ONE, NOT A
   * CONVENIENT ONE.** The ceiling asks what authority this round was raised
   * under. A role read later is a different question, and one that has no
   * answer at all once the seat is gone.
   *
   * **WRITTEN AT ALL SIX PROPOSE DOORS**, and that took a second pass to make
   * true: the first draft wrote it at `propose` and `proposeRun` only, leaving
   * the four GOVERNANCE doors — where a proposer being removed is the ordinary
   * case — falling through to the very lookup this field replaces.
   *
   * **UNDEFINED ON EVERY PROPOSAL WRITTEN BEFORE THIS FIELD**, which is why
   * `recordStanding` still falls back to the live lookup and refuses BY NAME
   * when both are absent, instead of asserting non-null. Not backfilled: the
   * records are sealed and a migration that guessed a role would be writing the
   * one value this field exists to stop being guessed.
   *
   * **AND WHAT MAKES THE STORED ROLE AND THE LIVE ROLE AGREE TODAY IS THAT
   * NOTHING CAN CHANGE A ROLE.** A role is set at `POST /api/accounts` and at
   * the signer-invite door and nowhere else; there is no demotion door in this
   * product. **The day one exists, a round raised by an admin who has since
   * been demoted will be judged at the ADMIN ceiling for ever, where the live
   * lookup would have used the new one.** That is the correct answer — the
   * ceiling asks what authority the round was raised under — but it is a
   * behaviour change nobody has decided, so it is written here rather than
   * discovered.
   *
   * **A CITATION THAT POINTS SOMEWHERE PLAUSIBLE BUT WRONG IS THE ONE DEFECT
   * THAT DEFEATS A READER SILENTLY:** they arrive, find something, and never
   * learn they are in the wrong place. Which is why every `file:line` in this
   * file is checked rather than copied.
   */
  proposerRole?: Role;
}

/**
 * **ANOTHER ATTEMPT AT PAYING SOME OF A LEG'S PEOPLE, KEPT ON THE LEG IT RETRIES.**
 *
 * A leg is approved once, over a tree of every person it pays. When that
 * attempt does not reach everybody - a window that closed with people still
 * owed, a vault that ran dry part way - the people it missed are paid by a
 * second approval over a smaller tree. **That second tree is built from the
 * SAME per-payee secrets as the first, so each person's leaf in it is
 * byte-for-byte the leaf they already had.** The account's record of completed
 * payments is keyed on the leaf, so whichever of the two attempts pays a
 * person first is the only one that can: the other is refused as a payment
 * already made.
 *
 * **WHAT THIS RECORD DOES NOT CARRY IS THE POINT OF ITS SHAPE.** There is no
 * identity here, no payment facts and no leaves. All three belong to the leg
 * this attempt lives on and are read from it, so there is no field in which
 * a retry could name a different run identity - and a different identity is
 * different secrets, different leaves, and a payment the account has never
 * seen and does not refuse. What a retry owns is only what genuinely differs:
 * which of the leg's people it is for, and the root, window and vault of its
 * own approval.
 *
 * **ON THE LEG AND NOT ON THE RUN, AND NOT AS A SECOND RUN.** A report asking
 * whether this period's payroll was paid asks it about one run and one set of
 * people. A retry recorded as a run of its own would be a second run for the
 * period, carrying an identity its own id does not produce.
 *
 * Declared here, below everything, and merged onto the interfaces it extends,
 * so that nothing above this line moves.
 */
export interface RunRetry {
  /**
   * Which of the leg's people this attempt pays: positions in the leg's own
   * recorded leaves, in the order this attempt's tree was built.
   */
  originalIndices: number[];
  /** The merkle root over those people's leaves. What the signers approve. */
  root: Hex;
  /** How many of them. Always the length of `originalIndices`. */
  payees: bigint;
  /** Seconds since the Unix epoch, because block time is compared against it. */
  opensAt: bigint;
  closesAt: bigint;
  /** The vault that will pay this attempt. */
  vault: Hex;
  /**
   * The proposal this attempt was raised as. Absent between the moment the
   * attempt is written down and the moment the raise returns, which is the
   * same order a leg's own material and its proposal are written in.
   */
  proposalId?: string;
  proposedBy: string;
  at: string;
}

export interface RunPayout {
  /**
   * **EVERY FURTHER ATTEMPT AT THIS LEG, OLDEST FIRST.** Absent until the
   * first; never an empty list. Nothing is ever removed from it: an attempt
   * that was raised stays on record whether or not it paid anybody.
   */
  retries?: RunRetry[];
}

/**
 * **A RUN THAT WAS DRAWN UP KNOWING IT REPEATS ANOTHER, AND ON WHOSE SAY-SO.**
 *
 * Two runs for one period that pay the same people the same amounts are,
 * to the account, two unrelated sets of payments: each run derives its own
 * per-payee secrets, so nothing on chain ties one to the other and both can
 * be paid. That is right for a deliberate second payment and it is a double
 * payroll for somebody who only meant to try again. **So a repeat is refused
 * unless somebody names the runs it repeats and says why, and this is what
 * they said.** It is read again when the run is raised, so a repeat that was
 * never confirmed cannot be raised by a different route.
 *
 * Inside the envelope, with the people it is about.
 */
export interface RunRepeatRecord {
  /** The runs this one knowingly repeats, by id. */
  of: string[];
  reason: string;
  by: string;
  at: string;
}

export interface PayrollRun {
  /** Absent on every run that repeats nothing. */
  repeats?: RunRepeatRecord;
}

/**
 * **ONE SIGNER'S PUBLIC KEYS FOR A COMPANY'S VAULTS**, given by that signer's
 * own wallet and device the first time they open the company here.
 *
 *   - `committeeKey` is the key they sit on every vault's committee with. Its
 *     secret half never leaves their wallet.
 *   - `recordsKey` is the key the vault's nonce secret is wrapped to for them.
 *   - `filingKey` is the key every sealed record they file is signed with; the
 *     service refuses a filing from them signed by any other.
 *
 * All three are public. Kept outside the sealed roster, so this service can
 * see which member gave which key - the same exposure as `memberUserIds` - and
 * a service that lied about another signer's keys would be believed by a
 * device assembling a committee of more than one.
 */
export interface VaultKeysOfASigner {
  accountId: string;
  userId: string;
  committeeKey: { tag: string; value: string };
  recordsKey: Hex;
  filingKey: Hex;
  givenAt: string;
}

/**
 * **A VAULT CREATED FROM THIS COMPANY'S PAGE.** A record that it was deployed
 * here and what committee it was to be handed to - never a record of who holds
 * it now. That is read from the chain every time it is asked.
 */
export interface CompanyVault {
  accountId: string;
  vault: Hex;
  deployedAt: string;
  deployRef: string;
  /** The committee the device said it would hand the vault to, at deploy time. */
  intended: { committee: { tag: string; value: string }[]; threshold: number };
}

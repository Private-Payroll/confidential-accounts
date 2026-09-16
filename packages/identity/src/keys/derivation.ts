import { HDWallet, Roles, generateMnemonicWords, validateMnemonic } from '@midnightntwrk/wallet-sdk-hd';
import { entropyToMnemonic, mnemonicToEntropy, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * ONE SECRET, TWO COMPARTMENTS — and every step that touches money below is the
 * SDK's own, not ours. §2.
 *
 * This file exists because the first version of it did not do that. It invented
 * a derivation, and a phrase produced by it opened nothing in any other
 * Midnight wallet. All of it was deleted. What is here now is the path the
 * Foundation's own testkit takes, in the same order, with the same arguments,
 * and `derivation.portability.test.ts` asserts the bytes match theirs before
 * anything else in the suite is allowed to matter.
 *
 * THE FAILURE THIS FILE IS SHAPED AROUND IS SILENT.
 *
 *   `HDWallet.fromSeed` accepts ANY seed between 16 and 64 bytes. Hand it the
 *   32-byte entropy instead of the 64-byte stretched seed and it does not
 *   error, does not warn, and does not differ in any observable way — it
 *   returns a perfectly valid wallet at a completely different place, which
 *   nobody else can reach from the same words. The person finds out when they
 *   need their money.
 *
 * So there is exactly one route from a person's secret to a key here, and the
 * intermediate values are not accepted from outside. `identityFrom*` is the
 * only door; `seedFromWords` is exported for one reason, which is to let the
 * portability test compare our 64 bytes with theirs.
 *
 * TWO COMPARTMENTS, AND THE SEPARATION IS THE HARDENED ACCOUNT INDEX:
 *
 *   account 0   THEIR MONEY. Pure SDK, index 0, nothing of ours anywhere near
 *               it. Another Midnight wallet, given these words, finds exactly
 *               this.
 *   account 1   THEIR AUTHORITY. One SDK-derived key, then HKDF — see below,
 *               because the obvious version of this is dangerous.
 *   account 2+  THEIR SUBWALLETS (`moneyAt`). More wallets from the same
 *               series, pure SDK like account 0. Account 1 is refused there
 *               BY NAME: a wallet offered at account 1 would hand out the
 *               authority root as a spending key — the same trap again, dressed as a
 *               dropdown entry.
 *
 * WHY AUTHORITY KEYS ARE NOT SIMPLY MORE SDK PATHS. Found by audit
 * before any of this shipped. The first version of this file derived a login
 * key as `selectAccount(1).selectRole(0).deriveKeyAt(0)` and called account 1
 * "ours". **It is not ours.** Testkit's own helper takes the account as a
 * parameter — `deriveKeyForRole(seed, role, account = 0, keyIndex = 0)` — so
 * account 1 is the person's SECOND WALLET ACCOUNT, which any wallet built on
 * this SDK will offer them in a dropdown. That made a login credential
 * byte-identical to the NIGHT spending key of that account, and a seat
 * credential identical to its dust key. Credentials get copied, escrowed and
 * handed to hosts. Spending keys must not.
 *
 * So: **one** key comes out of the SDK at a fixed authority path, and every
 * actual authority key is an HKDF-SHA256 expansion of it, domain-separated by
 * purpose and index. HKDF is RFC 5869 and the implementation is `@noble/hashes`
 * — this is expansion of one key into subkeys, which is what HKDF is for, and
 * it is not a derivation scheme of our own. The result is that **no authority
 * key is reachable at any BIP-44 path**, so none of them is a spending key of
 * anything.
 *
 * NO PASSPHRASE, DELIBERATELY. BIP-39 allows a 25th secret word that changes
 * the wallet entirely. Testkit calls `mnemonicToSeedSync(phrase)` with no
 * second argument, so a passphrase would put the wallet somewhere the rest of
 * the Midnight ecosystem does not look. Supporting it is a compatibility break
 * dressed as a feature.
 *
 * WHAT THE PORTABILITY TEST DOES NOT DO, said plainly so nobody reads more into
 * it than it says: **it does not spend.** It proves our bytes equal the
 * Foundation's bytes, which is far stronger than a fixture we wrote down
 * ourselves and is the best evidence available without a network. It is not a
 * transaction that settled.
 */

/** 32 bytes of entropy — 256 bits, which is what BIP-39 spells as 24 words. */
export const SECRET_BYTES = 32;

/** The only phrase length this library accepts. See `identityFromWords`. */
export const WORD_COUNT = 24;

/**
 * WHAT IS SPLIT FOR RECOVERY IS THIS, and not the 64-byte seed below it.
 * §7.4: the stretch from entropy to seed only goes one way, so
 * somebody who recovers from pieces of the SEED can never be shown their words
 * again. Pieces are cut from the entropy. This type is the thing recovery
 * carries.
 */
export type Secret = Uint8Array;

/*
 * MONEY KEYS AND AUTHORITY KEYS ARE DIFFERENT TYPES, and the brands are
 * module-private unique symbols so neither can be written anywhere else —
 * including in a test, which is the point.
 *
 * Both are 32 bytes, so without this they are interchangeable at every call
 * site. `ZswapSecretKeys.fromSeed` accepts either and the address that comes
 * out of an authority key encodes, validates and round-trips perfectly — and a
 * salary paid to it lands in a coin the payee's own wallet NEVER scans, because
 * a shielded wallet is started with exactly one key at account 0 index 0 and
 * there is no gap-limit scan anywhere in the SDK. That is a failure from
 * a second cause. A transposition here is now a type error.
 */
declare const moneyBrand: unique symbol;
declare const authorityBrand: unique symbol;

/** 32 bytes that belong to the person's wallet. Safe to turn into an address. */
export type MoneyKey = Uint8Array & { readonly [moneyBrand]: true };
/** 32 bytes that prove who somebody is. NEVER an address, never on a chain. */
export type AuthorityKey = Uint8Array & { readonly [authorityBrand]: true };

/** The person's money keys. Account 0, index 0 — one address per person. */
export interface MoneyKeys {
  /** Shielded. The address a salary is paid to. Role 3. */
  readonly zswap: MoneyKey;
  /** Dust — fees, if they ever pay their own. Role 2. */
  readonly dust: MoneyKey;
  /** Unshielded, if ever needed. Role 0. */
  readonly night: MoneyKey;
}

/**
 * WHAT AN AUTHORITY KEY IS FOR.
 *
 * These are strings and not numbers on purpose. They are the domain separator
 * fed to HKDF, so **the words themselves are part of the derivation**: renaming
 * one re-keys every credential of that kind for every person who exists. They
 * are pinned by recorded vectors in the test for exactly that reason.
 */
export const Purposes = {
  /** Proves you are you. Never on a transaction, never seen by the chain. */
  Login: 'login',
  /** One per device, so removing a device is removing a member. */
  Device: 'device',
  /** One per company, so no two employers see the same key. §3. */
  Seat: 'seat',
  /**
   * The key another wallet locks a recovery piece to. §7.10.
   *
   * It is in the authority compartment and not the money one on purpose: it is
   * published, it is not an address, and nothing should ever be paid to it.
   */
  Recovery: 'recovery',
  /**
   * THE KEY A PERSON'S OWN FACTS ARE SEALED UNDER.
   *
   * It seals and it never signs. Nothing is disclosed to anybody with this key
   * and nothing is proved with it: it is the AES-GCM key the profile ciphertext
   * lives under, on this device and on any device the profile later travels to.
   *
   * WHY A PURPOSE AND NOT A FRESH RANDOM KEY, which is the obvious alternative
   * and is worse in one specific way: a random key has to be STORED, so it has
   * to be moved, backed up and re-sealed, and the profile is then only as
   * portable as whatever moved it. Derived from the account secret, the key is
   * simply THERE on any device that has the secret — so pairing carries
   * ciphertext and no key, and the day there is somewhere durable to keep a
   * blob, sync is a storage backend rather than a migration of live personal
   * data (§4). It also means a recovered secret can open a profile, which is
   * strictly more than decision 4 promises and costs nothing to allow.
   *
   * ADDING THIS IS ADDITIVE AND THAT IS THE ONLY REASON IT IS ALLOWED HERE.
   * The four purposes above are untouched, so every credential already in
   * existence derives to the same bytes it did before this line was written —
   * pinned by the recorded vectors in `derivation.portability.test.ts`, which
   * this change ADDS a fifth vector to rather than changing any of.
   */
  Profile: 'profile',
  /**
   * THE ROOT OF THE PER-COMPANY KEYS THIS WALLET RELEASES,
   * AND IT IS ITSELF NEVER RELEASED.
   *
   * An application that a person has signed in to can ask this wallet to
   * release a key that opens the data that application holds FOR THAT PERSON.
   * The key that crosses is not this one: it is an HKDF expansion of this one
   * under the COMPANY'S OWN ACCOUNT CONTRACT ADDRESS (`packages/identity/src/profile/unlock.ts`).
   * This purpose is the parent, and nothing anywhere hands the parent to
   * anybody.
   *
   * **THE INGREDIENT CHANGED AND NOT THIS LINE.** The old key expanded under the
   * requesting ORIGIN; a hostname is a deployment detail, so anything sealed
   * under a key derived from ours could only ever be opened at ours, which is
   * the defect this closed. **The purpose string, its index and its bytes are untouched** —
   * `derivation.portability.test.ts`'s `unlock` vectors are byte-identical
   * before and after, because what moved is inside `profile/unlock.ts` and
   * not inside this file.
   *
   * WHY NOT `Purposes.Seat`, WHICH THE DESIGN NAMES AND WHICH ALREADY
   * EXISTS. Two reasons, and the second is the one
   * that decides it:
   *
   *   1. **`Seat`'s selector is an INDEX and an identifier is a STRING.**
   * §4 step 7 has seats keyed by a company the product itself
   *      numbers. Reaching a seat from a 256-bit address means squeezing it into
   *      the 31-bit index `authority` accepts — and a 31-bit selector can be
   *      GROUND to match. `packages/identity/src/profile/unlock.test.ts` finds two company
   *      addresses that land on one index, and the whole point of that round is
   *      that two companies never share a key.
   *   2. **A SEAT IS MEANT TO BE GIVEN AWAY, AND A KEY THAT IS GIVEN AWAY MUST
   *      NEVER BE THE ROOT OF KEYS THAT ARE NOT.** *"One per company, so no two
   *      employers see the same key."* If the parent of every company's key were
   *      a seat, the first company handed its seat could derive every other
   *      company's key. This purpose exists so the parent has exactly one job
   *      and never leaves the wallet.
   *
   * ADDITIVE, AND THAT IS THE ONLY REASON IT IS ALLOWED HERE — the same
   * sentence `Profile` above was added under. The five purposes above are
   * untouched, so every credential already in existence derives to the same
   * bytes; `derivation.portability.test.ts` ADDS a vector rather than changing
   * one, and fails BY NAME on a purpose that has none.
   */
  Unlock: 'unlock',
  /**
   * THE KEY A COMPANY SEALS A NOTIFICATION TO. The polled inbox.
   *
   * **IT IS `Purposes.Recovery`'s SHAPE FOR A DIFFERENT SENDER**, and that
   * comment three entries up is the whole argument: *"it is published, it is
   * not an address, and nothing should ever be paid to it."* An inbox key is
   * published to whoever may write to this person, it is an X25519 public key
   * and not a payment address, and it is in the authority compartment for
   * exactly the reason a recovery key is. `profile/inbox.ts` mirrors
   * `recovery/locks.ts:81`'s construction rather than inventing a second one.
   *
   * **IT ONLY EVER OPENS. IT NEVER SIGNS AND IT IS NEVER RELEASED.** The wallet seals
   * an acceptance OUT, to a key a company published; this is the direction
   * back, and the secret half stays in the wallet in every path there is.
   *
   * WHY NOT `Purposes.Seat`, WHICH THE INVITATIONS SCOPE NAMES FOR THE CHANGE
   * AFTER THIS ONE. Two reasons, and this file has already written both:
   *
   *   1. **A SEAT IS MEANT TO BE GIVEN AWAY** -- the sentence in `Unlock`
   *      above, applied one step further. A key whose holder may be somebody
   *      else is not a key that only this wallet opens with, and an inbox whose
   *      sender can read it is a broadcast.
   *   2. **`Seat`'s SELECTOR IS A 31-BIT INDEX AND CAN BE GROUND.**
   *      `packages/identity/src/profile/unlock.test.ts` finds two company addresses landing on
   *      one index. This change asks at ONE address for the whole person, so it
   *      needs no selector at all; the change that gives every company its own
   *      opaque inbox needs one that cannot collide, and that is a decision
   *      that round takes with the same measurement in front of it.
   *
   * WHY NOT THE PER-COMPANY UNLOCK KEY, which needs no new material at all: it
   * is RELEASED to the company (`profile/unlock.ts`). The sender would hold the
   * key the item is sealed to.
   *
   * ADDITIVE, AND THAT IS THE ONLY REASON IT IS ALLOWED HERE -- the same
   * sentence `Profile` and `Unlock` above were added under. The six purposes
   * above are untouched, so every credential already in existence derives to
   * the same bytes; `derivation.portability.test.ts` ADDS a vector rather than
   * changing one, and fails BY NAME on a purpose that has none.
   */
  Inbox: 'inbox',
  /**
   * THE ROOT OF THE KEY A PERSON'S OWN SAVED KEYS ARE SEALED UNDER, AT ONE SITE,
   * AND IT IS ITSELF NEVER RELEASED.
   *
   * A person who belongs to several companies at one site keeps one sealed set
   * of their own keys there - a signing secret, a wrapping secret and a
   * blinding for every company they sit on. **That set belongs to the PERSON
   * and not to any one company**, so the key it is sealed under cannot be a
   * company's key: sealed under one company's key, it could never hold a
   * second company's secrets beside the first. The released key is an HKDF
   * expansion of this parent under the person's own identifier at that site
   * (`profile/unlock.ts`, `keyringKeyFor`).
   *
   * WHY NOT `Purposes.Unlock` AT ANOTHER INDEX. That purpose's comment says it
   * has exactly one job and one index, and a second index chosen by a caller
   * is the selector that comment refuses. **A different thing gets a different
   * parent**, so no company key and no keyring key can ever be the same bytes,
   * whatever identifier either is expanded under.
   *
   * ADDITIVE, AND THAT IS THE ONLY REASON IT IS ALLOWED HERE -- the same
   * sentence every purpose after the first four was added under. The seven
   * purposes above are untouched, so every credential already in existence
   * derives to the same bytes; `derivation.portability.test.ts` ADDS a vector
   * rather than changing one, and fails BY NAME on a purpose that has none.
   */
  Keyring: 'keyring',
  /**
   * THE ROOT OF A PERSON'S VOTE ON WHO MAY CHANGE A COMPANY VAULT'S RULES.
   *
   * A vault's maintenance authority is a committee of signature keys, one per
   * company signer, and a maintenance update is valid only with enough of their
   * signatures. The key a person sits on that committee with is an expansion of
   * this parent under the company's address (`profile/committee-key.ts`), so it
   * differs per company and links nobody across companies.
   *
   * **ONLY ITS PUBLIC HALF EVER LEAVES THE WALLET.** A key that can sign
   * maintenance can replace the proofs a vault accepts, which is a key that can
   * move the vault's money; a page that held it could do that on its own.
   *
   * WHY NOT `Purposes.Unlock`. The unlock key is RELEASED to the company's page,
   * and the page already expands it into the key the company's records are
   * wrapped to. A committee key built on that parent would be computable by the
   * page. **A different job gets a different parent**, so no released key, no
   * records key and no committee key can ever be derived from one another.
   *
   * ADDITIVE, AND THAT IS THE ONLY REASON IT IS ALLOWED HERE -- the same
   * sentence every purpose after the first four was added under. The eight
   * purposes above are untouched, so every credential already in existence
   * derives to the same bytes; `derivation.portability.test.ts` ADDS a vector
   * rather than changing one.
   */
  Maintenance: 'maintenance',
} as const;

export type Purpose = (typeof Purposes)[keyof typeof Purposes];

export type DerivationFailure =
  /** The entropy handed in was not 32 bytes. */
  | 'secret-wrong-length'
  /** Not a valid BIP-39 phrase, or not twenty-four words. */
  | 'not-a-recovery-phrase'
  /** `HDWallet.fromSeed` refused the seed. */
  | 'seed-rejected'
  /** The SDK returned `keyOutOfBounds`, or an index we will not derive at. */
  | 'key-out-of-bounds'
  /** `moneyAt(1)` — the authority compartment is not a wallet. */
  | 'account-reserved';

export class DerivationError extends Error {
  readonly code: DerivationFailure;
  constructor(code: DerivationFailure, message: string) {
    super(message);
    this.name = 'DerivationError';
    this.code = code;
  }
}

/** The money account. Standard, and readable by any Midnight wallet. */
const MONEY_ACCOUNT = 0;
/**
 * One address per person, so index 0 and never a loop. A shielded wallet is
 * started with exactly one `ZswapSecretKeys` and would never see coins sent to
 * another index — handled elsewhere.
 */
const MONEY_INDEX = 0;

/**
 * The single SDK path the authority compartment stands on. Hardened at the
 * account level, so it yields nothing about the money and the money yields
 * nothing about it. Everything past this point is HKDF.
 */
const AUTHORITY_ACCOUNT = 1;
const AUTHORITY_ROOT_ROLE = Roles.NightExternal;
const AUTHORITY_ROOT_INDEX = 0;

/**
 * The HKDF salt. Versioned, because the day this string changes is the day
 * every credential in existence changes with it — which is a migration and not
 * a patch.
 */
const AUTHORITY_SALT = new TextEncoder().encode('midnight-identity/authority/v1');

/**
 * BIP-32 path components are whole numbers below 2^31. Authority keys no longer
 * travel a BIP-32 path and would not need the bound, but it is kept: if these
 * ever move back onto one, every index already handed out stays derivable.
 */
const MAX_INDEX = 2 ** 31;

/** A person's keys, all of them produced on demand from one secret. */
export interface Identity {
  /** The twenty-four words. Shown only if somebody asks to export. */
  readonly words: readonly string[];
  /** Account 0. What another wallet would find from the same words. */
  readonly money: MoneyKeys;
  /**
   * SUBWALLETS — the money keys of a NUMBERED wallet account. The seed yields
   * a numbered series of accounts and each number is a separate wallet: its
   * own address, its own balance, no visible connection to the others. This
   * is the SDK's own account parameter (`deriveKeyForRole(seed, role,
   * account, keyIndex)` in testkit) surfaced, nothing of ours added.
   *
   *   moneyAt(0)   `money`, byte for byte. Account 0 is unchanged, for ever.
   *   moneyAt(1)   REFUSED, always — `account-reserved`. Account 1 is the
   *                authority compartment, and a wallet offered there would
   *                have a NIGHT spending key byte-identical to the authority
   *                root: the same trap reproduced by a feature. The refusal lives
   *                here, at the only door, so no list a screen builds can
   *                reach it.
   *   moneyAt(2+)  subwallets.
   *
   * Recovery, securing and pairing carry the SECRET and need no account
   * argument: every account derives from it on the spot, including accounts
   * first used years after the pieces were placed.
   */
  moneyAt(account: number): MoneyKeys;
  /**
   * Cut fresh each time and never stored.
   *
   * `index` is what separates one company or device from another. Choosing it
   * is not this file's business and is deliberately not decided here — see
   * §4 step 7.
   */
  authority(purpose: Purpose, index: number): AuthorityKey;
}

/** Thirty-two fresh random bytes. The only place a new identity begins. */
export function newSecret(): Secret {
  return crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
}

/**
 * A phrase, from either shape it arrives in, with the words normalised.
 *
 * Lower-cased and re-spaced because people paste from a screenshot, a notes
 * app, or a printed sheet, and BIP-39 is exact about both.
 */
function phraseOf(words: readonly string[] | string): string {
  const raw = Array.isArray(words) ? words.join(' ') : String(words);
  return raw.normalize('NFKD').trim().toLowerCase().split(/\s+/u).join(' ');
}

/** The words for a secret. */
export function wordsFromSecret(secret: Secret): string[] {
  if (secret?.length !== SECRET_BYTES) {
    throw new DerivationError(
      'secret-wrong-length',
      `a secret is ${SECRET_BYTES} bytes; got ${secret?.length ?? 'nothing'}. `
      + 'This is the entropy, not the 64-byte seed.');
  }
  return entropyToMnemonic(secret, wordlist).split(' ');
}

/**
 * The secret behind a phrase — and the checksum is CHECKED here, which is the
 * whole reason this function exists rather than a call to `mnemonicToSeedSync`.
 *
 * `mnemonicToSeedSync` does not validate. A phrase with one word mistyped
 * stretches happily into a different seed and seeds a different wallet, in
 * silence. Every route into this module goes through this check first.
 */
export function secretFromWords(words: readonly string[] | string): Secret {
  const phrase = phraseOf(words);
  if (!validateMnemonic(phrase)) {
    throw new DerivationError(
      'not-a-recovery-phrase',
      'that is not a valid recovery phrase. Every word must be from the BIP-39 '
      + 'list and the phrase carries its own checksum, so a single mistyped or '
      + 'reordered word fails here rather than silently opening a different wallet.');
  }
  return mnemonicToEntropy(phrase, wordlist);
}

/**
 * THE 64 BYTES, AND THE ONLY REASON THIS IS EXPORTED IS THE PORTABILITY TEST.
 *
 * Nothing in the library should hand these around: it is the value that, given
 * to `HDWallet.fromSeed` in place of the entropy, produces a silently different
 * wallet.
 */
export function seedFromWords(words: readonly string[] | string): Uint8Array {
  const phrase = phraseOf(words);
  if (!validateMnemonic(phrase)) {
    throw new DerivationError('not-a-recovery-phrase', 'that is not a valid recovery phrase.');
  }
  /* No passphrase. See the header. */
  return mnemonicToSeedSync(phrase);
}

/**
 * A person, from their words.
 *
 * TWELVE WORDS ARE REFUSED HERE, and that is deliberate. BIP-39 is happy with 12,
 * 15, 18, 21 or 24 words, and every one of them produces a valid, portable
 * wallet — but a shorter phrase carries a shorter secret, and **the secret is
 * what recovery cuts into pieces**. The first version of this function
 * validated the phrase and threw the secret away, so a twelve-word import gave
 * somebody a working account whose recovery was already dead: the pieces
 * reassemble into 16 bytes and `identityFromSecret` refuses them, on a new
 * device, at the moment they have nothing else. The refusal belongs here, while
 * they still have the other wallet open.
 */
export function identityFromWords(words: readonly string[] | string): Identity {
  const phrase = phraseOf(words);
  /* The RETURN VALUE is used. A validation whose result is discarded is a check
   * only half the module performs. */
  const secret = secretFromWords(phrase);
  if (secret.length !== SECRET_BYTES) {
    throw new DerivationError(
      'not-a-recovery-phrase',
      `this library uses ${WORD_COUNT}-word recovery phrases and that one has `
      + `${phrase.split(' ').length}. It is a valid phrase, and a wallet built from it here `
      + 'could not be recovered from its own pieces later — so it is refused now rather '
      + 'than when it matters.');
  }
  return build(phrase);
}

/** A person, from their secret. The path a new sign-up takes. */
export function identityFromSecret(secret: Secret): Identity {
  return build(wordsFromSecret(secret).join(' '));
}

function build(phrase: string): Identity {
  /*
   * The same call `seedFromWords` makes, deliberately not routed through it —
   * the phrase has already been validated by the caller and re-validating is
   * noise. If these two ever diverge, the authority tests notice immediately:
   * they build their independent root from `seedFromWords` and compare it with
   * a key that came out of here.
   */
  const seed = mnemonicToSeedSync(phrase);
  const result = HDWallet.fromSeed(seed);
  if (result.type !== 'seedOk') {
    throw new DerivationError(
      'seed-rejected',
      `the wallet SDK refused this seed: ${String(
        (result as { error?: unknown }).error ?? 'no reason given')}`);
  }
  const hd = result.hdWallet;

  /*
   * One call for all three, so a partial money compartment cannot exist. The
   * SDK reports every role that failed rather than the first.
   *
   * Shared by account 0 and the subwallets because it must be IMPOSSIBLE for
   * the two to derive differently: `moneyAt(0)` and `money` are the same
   * bytes for the same reason a single function cannot disagree with itself.
   */
  const deriveMoneyKeys = (account: number): MoneyKeys => {
    const money = hd
      .selectAccount(account)
      .selectRoles([Roles.Zswap, Roles.Dust, Roles.NightExternal] as const)
      .deriveKeysAt(MONEY_INDEX);

    if (money.type !== 'keysDerived') {
      throw new DerivationError(
        'key-out-of-bounds',
        `the wallet SDK could not derive the money keys for roles ${money.roles.join(', ')}`);
    }

    return Object.freeze({
      zswap: money.keys[Roles.Zswap] as MoneyKey,
      dust: money.keys[Roles.Dust] as MoneyKey,
      night: money.keys[Roles.NightExternal] as MoneyKey,
    });
  };

  /* Derived eagerly, exactly as before the account parameter existed: the
   * zero-argument behaviour of this module is `MONEY_ACCOUNT = 0`, unchanged. */
  const keys = deriveMoneyKeys(MONEY_ACCOUNT);

  const moneyAt = (account: number): MoneyKeys => {
    if (!Number.isSafeInteger(account) || account < 0 || account >= MAX_INDEX) {
      throw new DerivationError(
        'key-out-of-bounds',
        `a wallet account must be a whole number from 0 to ${MAX_INDEX - 1}; got ${account}`);
    }
    if (account === AUTHORITY_ACCOUNT) {
      throw new DerivationError(
        'account-reserved',
        `account ${AUTHORITY_ACCOUNT} is the authority compartment, not a wallet. Its NIGHT `
        + 'key is the root every login and device credential expands from, so offering it '
        + 'as a wallet would put a spending key on screens and servers that only ever '
        + 'expect credentials. Subwallets start at account 2.');
    }
    if (account === MONEY_ACCOUNT) return keys;
    return deriveMoneyKeys(account);
  };

  const rootResult = hd
    .selectAccount(AUTHORITY_ACCOUNT)
    .selectRole(AUTHORITY_ROOT_ROLE)
    .deriveKeyAt(AUTHORITY_ROOT_INDEX);
  if (rootResult.type !== 'keyDerived') {
    throw new DerivationError(
      'key-out-of-bounds', 'the wallet SDK could not derive the authority root');
  }
  const authorityRoot = rootResult.key;

  const authority = (purpose: Purpose, index: number): AuthorityKey => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_INDEX) {
      throw new DerivationError(
        'key-out-of-bounds',
        `an authority index must be a whole number from 0 to ${MAX_INDEX - 1}; got ${index}`);
    }
    const info = new TextEncoder().encode(`${purpose}/${index}`);
    return hkdf(sha256, authorityRoot, AUTHORITY_SALT, info, 32) as AuthorityKey;
  };

  /*
   * `hd.clear()` is NOT called here and must not be. It wipes the root key in
   * place, which breaks every handle already issued — including this closure —
   * and the SDK itself never calls it. §2.
   */
  return Object.freeze({
    words: Object.freeze(phrase.split(' ')),
    money: keys,
    moneyAt,
    authority,
  });
}

/** Twenty-four fresh words. The SDK's own generator, at its default strength. */
export function newWords(): string[] {
  return generateMnemonicWords();
}

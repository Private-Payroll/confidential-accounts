import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Purposes } from '../keys/derivation.js';
import { committeeKeyFor, readCommitteeKey } from './committee-key.js';
import type { SignatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import type { Identity } from '../keys/derivation.js';
import { fromBase64Url, toBase64Url } from '../passkey/bytes.js';
import type { KeyringRequest, UnlockRequest } from './request.js';
import { usableOrigin, whyNotUsable } from './origin.js';

/**
 * THE KEY THIS WALLET RELEASES, AND EVERYTHING THAT MAKES IT SAFE TO.
 *
 * ── WHAT THIS IS, AGAINST THE TWO THINGS IT IS NOT ────────────────────────
 * A **sign-in** tells a site who somebody is. A **disclosure** tells it a
 * fact. **This gives it something that keeps working.** A disclosure is a
 * statement about the past and a signature over it can be checked for ever; a
 * key is a CAPABILITY FOR THE FUTURE. It cannot be taken back, it does not
 * expire on its own, and **the person cannot see what is being done with it.**
 * Every rule below follows from that one difference.
 *
 * ══ WHAT THE KEY BELONGS TO, AND WHY IT CHANGED ══════════════════════
 *
 * **THIS KEY WAS DERIVED FROM THE REQUESTING ORIGIN. THAT WAS RIGHT ABOUT WHO
 * IS ASKING AND WRONG ABOUT WHAT THE KEY BELONGS TO.**
 *
 * A hostname is a DEPLOYMENT DETAIL. It changes when a company self-hosts,
 * when somebody builds a second client, when we move, and it ceases to exist
 * when we do. **Anything sealed under a key derived from our address can only
 * ever be opened at our address** — so the sealed export this project committed
 * an architecture to, a customer taking their copy to any client, arrives
 * somewhere else and does not open. That defect, reopened by the mechanism meant to
 * serve it.
 *
 * **SO THE KEY IS DERIVED FROM THE COMPANY'S ACCOUNT CONTRACT ADDRESS.**
 * Chain-assigned, stable for as long as the company exists, not ours to mint
 * and not ours to rename, and it outlives us — which is the entire point of
 * choosing it.
 *
 * **THE ORIGIN STILL DECIDES WHO MAY BE HANDED SOMETHING.** It is still
 * observed, still refused when it is not a plain `https://` serialisation, and
 * still the only address this wallet posts an answer to. It is simply not an
 * ingredient of the key any more. `originOf` below GATES and does not DERIVE,
 * and that division is the whole of the change.
 *
 * ══ THE COST, SAID OUT LOUD ═══════════════════════════════════════════════
 *
 * **THE COMPANY IDENTIFIER IS THE ONE CLAIMED VALUE IN THIS WHOLE PROTOCOL.**
 * The origin comes from the browser; the company address comes from the
 * request, because there is nowhere else it could come from. That is a genuine
 * loss of the property this was built around, and it was accepted knowingly on
 * 23 Aug for a stated reason: deriving
 * from the origin is strictly better against PHISHING, because a key minted for
 * `evil.example` opens nothing; deriving from the company means a phished key
 * is a REAL key — **useless on its own, dangerous only to somebody who has ALSO
 * obtained the sealed data.** One is a design flaw, the other a compound of two
 * separate breaches. A product that cannot be left is a certainty.
 *
 * **WHAT THE DESIGN OWES IN RETURN IS THAT A PERSON CAN SEE THE MISMATCH**, and
 * that debt is paid on the screen (`app/screens/approve.tsx`), not here: the
 * observed origin and the company being opened are shown together, neither
 * smaller than the name the site chose for itself, and a company asked for from
 * an origin it has not been given to before says so before the button.
 *
 * ══ THE FIVE RULES, AND WHERE EACH ONE LIVES ══════════════════════════════
 *
 * **1. AT FULL WIDTH, AS ITS OWN BYTES.** The finding stands and applies here
 * unchanged: **a selector narrower than the thing it selects can be ground.**
 * That round ground two origins onto one 31-bit index in 2,855,179,063 tries on
 * one core. So the address goes into the expansion
 * WHOLE — all sixty-four characters, not folded, not truncated, not hashed into
 * an index.
 *
 * **2. THE SAME COMPANY REACHED FROM TWO DIFFERENT HOSTS GETS THE SAME KEY.**
 * This is the whole purpose of the change: it is the export, expressed as code.
 * **The origin appears nowhere in the derivation below.**
 *
 * **3. TWO COMPANIES NEVER GET THE SAME KEY**, and a wallet rebuilt from its
 * seed alone derives both identically. Nothing here reads storage, a clock, a
 * counter or a random number.
 *
 * **4. IT IS NEVER A MONEY KEY.** The parent is `Purposes.Unlock`, in
 * the authority compartment, which reaches no BIP-44 path at all; the released
 * key is an HKDF expansion of that. `unlock.test.ts` walks every account, role
 * and index a wallet would show and asserts the released bytes are none of them.
 *
 * **5. THE REMEMBERED LIST IS NEVER AN INPUT.** The wallet remembers which
 * origin asked for which company in order to WARN (`model.ts`, `originsFor`).
 * **It is a convenience and never a key input**: losing it costs a warning, not
 * access. The moment it became an input, a recovered wallet would stop opening a
 * company's records and we would be back at that defect by a different door. **This
 * function takes an identity and an ask, and there is no third argument.**
 *
 * ══ WHY THE KEY IS FIT TO BE A ROOT ═══════════════════════════════════════
 *
 * The employee's payslip key is the same move one level down, and it
 * is NOT built here. What this change owes it is a key fit to be its root, and
 * this one is: it is thirty-two bytes of HKDF-SHA256 output, it is a pure
 * function of a seed and a chain-assigned identifier, it is recomputable on any
 * device and after any recovery, and it is stored nowhere. **A wrapping keypair
 * derived from it needs no backup and can be recomputed rather than kept**,
 * which is the whole of what that key asks for. Nothing about it is random and
 * nothing about it depends on us existing.
 *
 * ══ WHY NOT `Purposes.Seat`, WHICH THE DESIGN NAMES ═══════════════════════
 *
 * The design this was built from says *"the wallet derives `Purposes.Seat` for
 * the requesting origin"*.
 * **Seat is the right IDEA and the wrong DOOR**, and the two reasons both
 * survive the change of ingredient:
 *
 * `authority(purpose, index)` selects with a NUMBER below 2^31. Squeezing any
 * identifier — an origin then, a contract address now — into 31 bits is a
 * selector that can be ground, and rule 3 is that two companies never share a
 * key. A 64-hex address is 256 bits; 31 of them is not the address.
 *
 * **AND SEAT IS MEANT TO BE GIVEN AWAY.** *"One per company, so no two
 * employers see the same key."* A key that is handed to a company must never be
 * the PARENT of keys that are not — the first employer handed its seat could
 * derive every other employer's. So the parent is a purpose with exactly one
 * job, which never leaves this wallet: only its per-company children do.
 *
 * ══ THE ADDRESS GOES IN AS ITS OWN BYTES, IN ONE SPELLING ═════════════════
 *
 * **MEASURED, NOT ASSERTED.** `encodeContractAddress` in
 * `@midnightntwrk/ledger-v9` (`ledger-v9.d.ts:475`) takes a `ContractAddress`,
 * which the same file declares as a bare `string` (`:33`). Running it settles
 * what the string is: `sampleContractAddress()` returns **sixty-four LOWERCASE
 * hex characters**, and `encodeContractAddress` of one returns **thirty-two
 * bytes**. It also ACCEPTS the uppercase spelling of the same address, because
 * the hex decoder underneath is case-insensitive — **so the SDK would let one
 * company arrive as two different strings.**
 *
 * **EVERY SPELLING BUT THE CANONICAL ONE WAS REFUSED. THIS FOLDS INSTEAD.**
 * Refusing was stricter than Midnight itself: the SDK's own validator
 * accepts `[0-9A-Fa-f]` and rejects only a `0x` prefix
 * (`@midnight-ntwrk/midnight-js-utils/dist/index.mjs:576`, `:986`, `:991`), so
 * an address every Midnight tool calls valid arrived here and was refused, and
 * the person was told their company is not a company.
 *
 * **The danger the strictness was for is real and folding prevents it BETTER.**
 * Two spellings of one company must never be two keys: a company whose records
 * open under one spelling and not the other has lost them, which is that defect with
 * a smaller radius. `payload.ts`'s NFC normalisation is right there and would be
 * wrong here for a reason that does not apply to hex — normalising TEXT is a
 * many-to-one map over things that merely look alike, and a key that must be
 * found again for ever cannot come from one of those. **Case-folding hex is
 * one-to-one on addresses**: sixty-four hex characters have exactly one
 * lower-case spelling, two different addresses can never fold together, and the
 * fold is the same on every client for ever. It removes the danger completely
 * AND accepts what the chain's own tools emit.
 *
 * **`request.ts` FOLDS AT THE DOOR AND THIS MODULE FOLDS AT ITS OWN**, for the
 * reason there is a second origin check: a caller that assembled an ask by hand
 * never went through the parser.
 *
 * ══ WHAT IS NOT SIGNED, AND THAT IS DELIBERATE ════════════════════════════
 *
 * A disclosure is signed because a recipient has to believe a claim about a
 * person. **A key needs no such witness: it opens the data or it does not.**
 * No spending key is put to work anywhere in this flow — the one place this
 * repository signs with a NIGHT key is `disclosure.ts`, and an unlock never
 * reaches it.
 *
 * **THE REPLAY BINDING IS STILL IN THE KEY ITSELF, AND IT IS NOW A COMPANY'S
 * RATHER THAN A HOST'S.** The key for company A does not open company B's
 * records, whatever host either was asked for from. `readRelease` takes the
 * recipient's OWN origin, its OWN nonce and the company it ITSELF asked about,
 * and compares; it reads none of the three out of the message, for
 * `disclosure.ts`'s reason — a value that agrees with itself is what a forged
 * one looks like.
 */

/* The domain this expansion lives in. **`v2`, and this is the only moment
 * it will ever be free to change.** `v1` expanded an ORIGIN; this expands a
 * COMPANY. Not one byte anywhere has been sealed under a `v1` key — payroll's
 * half is unbuilt — so the string moves once, now, rather than two derivations
 * of different things sharing one domain. The day it changes again is the day
 * every company's data stops opening, so it is a migration and never a patch. */
const UNLOCK_SALT = new TextEncoder().encode('midnight-identity/unlock/v2');

/** One parent, one job. There is no second index and nothing chooses one. */
const UNLOCK_PARENT_INDEX = 0;

/** Base64url of 32 bytes, so a released key is 43 characters. */
const KEY_BYTES = 32;

/* `MAX_ORIGIN` moved to `origin.ts` with the rule it belonged to. */

/*
 * A RELEASED KEY IS ITS OWN TYPE, and the brand is a module-private symbol so
 * nothing outside this file can write one. Same reason `MoneyKey` and
 * `AuthorityKey` are branded in `derivation.ts`: all three are 32 bytes, so
 * without this they are interchangeable at every call site, and the one
 * transposition that matters — releasing a spending key — would be a diff
 * rather than a type error.
 */
declare const releasedBrand: unique symbol;

/** 32 bytes that open ONE company's records. Never an address, never on a chain. */
export type ReleasedKey = Uint8Array & { readonly [releasedBrand]: true };

export const RELEASE_SCHEMA = 'midnight-identity/unlock-release/v1';

export type UnlockFailure =
  /** The origin is not a plain ASCII `https://` serialisation. */
  | 'origin-not-usable'
  /** The company is not a plain, complete, correctly-shaped address. */
  | 'company-not-usable'
  /** The person a keyring ask names is not an identifier this wallet can use. */
  | 'person-not-usable'
  /** The address the page signed in as is not an address of any account this wallet holds. */
  | 'address-not-held';

export class UnlockError extends Error {
  readonly code: UnlockFailure;
  constructor(code: UnlockFailure, message: string) {
    super(message);
    this.name = 'UnlockError';
    this.code = code;
  }
}

/*
 * **THIS MODULE'S OWN COPY OF THE ORIGIN RULE IS GONE. THE DOOR IS NOT.**
 *
 * `USABLE_ORIGIN` was here — a full ASCII pattern, written here because
 * the shared parser only tested how a name STARTED. It was the stricter of the
 * two and keeping it was right at the time. **What it must not become is the
 * reason nobody ever fixes the shared one**, so the shared one is fixed and
 * this module calls it.
 *
 * **THE DOOR STAYS AND ONLY THE DUPLICATE RULE GOES**, for the reason this file
 * has always given for having one: a caller that assembled an ask by hand never
 * went through the parser. Two doors, one rule — rather than two rules that
 * agree until the day one of them is edited.
 *
 * It was also, quietly, weaker in one direction: `[\x21-\x7e]+` admits `/`,
 * so `https://payroll.example/some/path` passed it. `origin.ts` parses, and a
 * path is not part of an origin.
 */

/**
 * **WHAT A MIDNIGHT CONTRACT ADDRESS LOOKS LIKE, MEASURED FROM THE SDK.**
 *
 * Sixty-four hex characters — the serialisation `sampleContractAddress()`
 * produces and `encodeContractAddress` turns into thirty-two bytes
 * (`@midnightntwrk/ledger-v9`, `ledger-v9.d.ts:475`, `:549`). Complete and
 * plain.
 *
 * **ANY SPELLING IN, ONE SPELLING ON.** Midnight's own validator
 * accepts `[0-9A-Fa-f]`, so this does; `companyOf` lower-cases before anything
 * reads the value, so the derivation only ever sees the canonical form.
 *
 * **A `0x` PREFIX IS REFUSED AND NEEDS NO CLAUSE OF ITS OWN**: this is
 * sixty-four characters exactly, so `0x` plus an address is sixty-six, and `0x`
 * plus sixty-two hex characters is not hex. The SDK refuses it explicitly —
 * `assertIsContractAddress`,
 * `@midnight-ntwrk/midnight-js-utils/dist/index.mjs:986` — and this refuses it
 * by shape.
 */
const COMPANY_ADDRESS = /^[0-9a-fA-F]{64}$/u;

const originOf = (ask: { readonly requester: { readonly origin: string } }): string => {
  const origin = ask.requester.origin;
  if (!usableOrigin(origin)) {
    throw new UnlockError(
      'origin-not-usable',
      whyNotUsable(origin)
      + ' No key has been given.');
  }
  return origin;
};

/**
 * THE COMPANY WHOSE RECORDS ARE BEING OPENED.
 *
 * **A MALFORMED IDENTIFIER IS A REQUEST THAT DOES NOT KNOW WHAT IT IS ASKING
 * FOR**, and this refuses it by name rather than deriving a key for a string
 * nothing on any chain will ever match. `request.ts` checks the same shape at
 * the parse; this is the module's own door, for the same reason there is one
 * for the origin — a caller that assembled an ask by hand meets it too.
 */
const companyOf = (ask: UnlockRequest): string => {
  const company = ask.company;
  if (typeof company !== 'string' || !COMPANY_ADDRESS.test(company)) {
    throw new UnlockError(
      'company-not-usable',
      'this asks for the key to a company this wallet cannot make sense of. A company is '
      + 'named by its own address on the chain, and that is not one. Nothing has been given.');
  }
  /*
   * **THE FOLD, AND IT IS THE LAST THING THAT HAPPENS BEFORE THE DERIVATION.**
   * Every spelling of one company yields the same bytes because every
   * spelling reaches `hkdf` as the same string. Move this below the caller and
   * two spellings become two keys again, which is the whole thing being
   * prevented.
   */
  return company.toLowerCase();
};

/**
 * THE KEY FOR ONE COMPANY. A pure function of the person's seed and the
 * COMPANY'S OWN ADDRESS, and of nothing else.
 *
 * **THE ORIGIN IS CHECKED HERE AND IS NOT AN INGREDIENT.** It gates: a request
 * whose origin this wallet could not observe gets no key at all. It does not
 * derive: the same company asked for from two hosts yields the same bytes,
 * which is the entire point and is the property the export rests on.
 *
 * **IT TAKES THE PARSED ASK RATHER THAN A STRING**, and there is no third
 * argument. Nothing stored can reach this function, so nothing stored can
 * change what comes out of it.
 */
export function unlockKeyFor(identity: Identity, ask: UnlockRequest): ReleasedKey {
  originOf(ask);
  const company = companyOf(ask);
  const parent = identity.authority(Purposes.Unlock, UNLOCK_PARENT_INDEX);
  /* The address's own bytes, at full width. Not folded, not truncated, not
   * hashed into an index — the header says why each of those would be wrong. */
  const info = new TextEncoder().encode(company);
  return hkdf(sha256, parent, UNLOCK_SALT, info, KEY_BYTES) as ReleasedKey;
}

/**
 * WHAT CROSSES BACK.
 *
 * **`key` IS THE ONE FIELD IN THIS REPOSITORY THAT IS A SECRET ON THE WIRE.**
 * It goes to the observed origin and nowhere else (`channel.ts` posts to
 * `origin`, never to `'*'`), it is never written to storage, to a history
 * entry, to a URL or to a log, and no screen renders it.
 */
export interface UnlockRelease {
  readonly schema: typeof RELEASE_SCHEMA;
  /** OBSERVED. A convenience for the requester, never an authority. */
  readonly origin: string;
  /** The company this key opens. Echoed back, and never read as authority. */
  readonly company: string;
  /** The nonce the requester chose, so it can tie this to its own request. */
  readonly nonce: string;
  /** The wallet's clock, in ms. */
  readonly at: number;
  /** Base64url of 32 bytes. **Do not log this. Do not store it.** */
  readonly key: string;
  /**
   * **WHERE THIS WALLET READS THE CHAIN.** Public: two addresses, the same for
   * every person using this wallet, and never a secret. A requester that wants
   * to read a contract itself reads it through these, so the answer rests on
   * the indexer this wallet already reads its own balance from, rather than
   * on the requester's own service.
   * Absent from a wallet that does not say.
   */
  readonly indexer?: WalletIndexer;
}

/** The two addresses a wallet reads the chain through. */
export interface WalletIndexer {
  /** The indexer's HTTP address, which answers a read. */
  readonly indexerUri: string;
  /** Its websocket address, which answers a subscription. */
  readonly indexerWsUri: string;
}

/** The message a person's press produces. The only thing that builds one. */
export function releaseFor(
  identity: Identity, ask: UnlockRequest, at: number, indexer?: WalletIndexer,
): UnlockRelease {
  return Object.freeze({
    schema: RELEASE_SCHEMA,
    origin: originOf(ask),
    company: companyOf(ask),
    nonce: ask.nonce,
    at,
    key: toBase64Url(unlockKeyFor(identity, ask)),
    ...(indexer === undefined
      ? {}
      : { indexer: Object.freeze({ indexerUri: indexer.indexerUri, indexerWsUri: indexer.indexerWsUri }) }),
  });
}

/** The longest indexer address read back. A URL, not a document. */
const MAX_INDEXER_ADDRESS = 512;

/**
 * **THE WALLET'S INDEXER, IF IT NAMED ONE AND IT READS AS TWO ADDRESSES.**
 * Anything else answers `null`: a release is still a good release without
 * it, and the requester then reads nothing rather than reading from a guess.
 */
const indexerOf = (said: unknown): WalletIndexer | null => {
  if (typeof said !== 'object' || said === null) return null;
  const { indexerUri, indexerWsUri } = said as Record<string, unknown>;
  const usable = (v: unknown): v is string =>
    typeof v === 'string' && v.length > 0 && v.length <= MAX_INDEXER_ADDRESS;
  return usable(indexerUri) && usable(indexerWsUri) ? { indexerUri, indexerWsUri } : null;
};

/* ------------------------- reading one, over there ------------------------ */

export type ReleaseFailure =
  | 'not-a-release'
  | 'origin-mismatch'
  | 'company-mismatch'
  | 'nonce-mismatch'
  | 'unusable-key';

export type ReleaseRead =
  | {
    readonly ok: true; readonly key: Uint8Array; readonly at: number;
    /** Where the wallet reads the chain, or `null` when it did not say. */
    readonly indexer: WalletIndexer | null;
  }
  | { readonly ok: false; readonly code: ReleaseFailure; readonly says: string };

/**
 * **THE REQUESTER'S SIDE, AND IT READS NO FIELD OUT OF THE MESSAGE.**
 *
 * It ships here for `disclosure.ts`'s reason: the thing the payroll product
 * runs should be the thing this change tested, rather than a description of it.
 *
 * `atOrigin` is the recipient's OWN origin, `expectingNonce` the nonce it
 * itself issued, and **`forCompany` the company it itself asked about** — this
 * addition, and the one that matters most on this side. A page holding a key
 * meant for a different company would seal or open the wrong company's records
 * under it, and the wallet cannot prevent that; the reader can.
 */
export function readRelease(
  message: unknown,
  expecting: {
    readonly atOrigin: string;
    readonly expectingNonce: string;
    readonly forCompany: string;
  },
): ReleaseRead {
  const body = message as UnlockRelease | null;
  if (typeof body !== 'object' || body === null || body.schema !== RELEASE_SCHEMA) {
    return { ok: false, code: 'not-a-release', says: 'that is not a released key.' };
  }
  if (body.origin !== expecting.atOrigin) {
    return {
      ok: false,
      code: 'origin-mismatch',
      says: `this key was released for ${String(body.origin)} and was received at `
        + `${expecting.atOrigin}. It is refused.`,
    };
  }
  /* Both sides folded before they are compared. The wallet echoes the
   * canonical spelling, and a requester that asked in another one must not have
   * its own key refused for a difference that is not a difference. */
  if (String(body.company).toLowerCase() !== expecting.forCompany.toLowerCase()) {
    return {
      ok: false,
      code: 'company-mismatch',
      says: 'this key opens a different company from the one that was asked about. It is '
        + 'refused rather than used, because a key used against the wrong company seals '
        + 'records nobody can open again.',
    };
  }
  if (body.nonce !== expecting.expectingNonce) {
    return {
      ok: false,
      code: 'nonce-mismatch',
      says: 'this answers a different request from the one that was sent.',
    };
  }
  let key: Uint8Array;
  try {
    key = fromBase64Url(body.key);
  } catch {
    return { ok: false, code: 'unusable-key', says: 'the key is not readable.' };
  }
  if (key.length !== KEY_BYTES) {
    return {
      ok: false,
      code: 'unusable-key',
      says: `a released key is ${KEY_BYTES} bytes and that one is ${key.length}.`,
    };
  }
  if (typeof body.at !== 'number' || !Number.isSafeInteger(body.at)) {
    return { ok: false, code: 'not-a-release', says: 'that is not a released key.' };
  }
  return { ok: true, key, at: body.at, indexer: indexerOf(body.indexer) };
}

/* ============================ the keyring key ============================ */

/*
 * **THE KEY A PERSON'S OWN SAVED KEYS AT ONE SITE ARE SEALED UNDER.**
 *
 * ── WHY A COMPANY'S KEY COULD NOT BE IT ────────────────────────────────────
 *
 * A person keeps ONE sealed set of their own keys at a site: for every company
 * they sit on there, the signing secret, the wrapping secret and the blinding
 * that exists nowhere else in the world. **Sealed under the key for one
 * company, that set could never hold a second company's secrets**, because the
 * key released for the second company is a different key and opens nothing the
 * first sealed. One wallet address could belong to one company, however the
 * screens were arranged. So the set is sealed under a key that belongs to the
 * PERSON at that site, and each company's secrets live inside it: one door to
 * your own keys, and many keys behind it. It is also what lets a person's keys
 * be saved before a company has an address on any chain.
 *
 * ── WHAT IT IS DERIVED FROM, AND WHAT IT IS NOT ────────────────────────────
 *
 * **FROM THE SEED AND THE SITE'S OWN IDENTIFIER FOR THE PERSON, AND NOTHING
 * ELSE.** A different parent (`Purposes.Keyring`) and a different salt from the
 * company key, so no company key and no keyring key are ever the same bytes.
 *
 * **NOT FROM THE ORIGIN**, for the reason the company key gave up the origin:
 * a hostname changes when a site moves or is self-hosted, and a set of keys
 * sealed under a key derived from one could only ever be opened at one address.
 * The origin gates, exactly as it does above.
 *
 * **NOT FROM THE ADDRESS THE PERSON SIGNED IN AS.** That address is text whose
 * spelling belongs to the chain's tooling and to the network's name; if either
 * ever spelled the same key differently, every set of keys sealed under a key
 * derived from the spelling would stop opening, with nothing failing until the
 * day somebody needed them. **The address gates instead**: the key is not given
 * unless one of this wallet's own accounts has exactly that address.
 *
 * **WHAT THE IDENTIFIER COSTS, SAID OUT LOUD.** It is minted by the site, not by
 * a chain, so it is only as durable as the site's own record of the person - and
 * that record is where the sealed set is kept, so the two move together. A site
 * that re-issued identifiers to the same people would strand every set of keys
 * it holds. It is also the only thing separating one site's keys from another's
 * for the same wallet, which is why it is an ingredient at all.
 *
 * ── WHAT IT OPENS, WHICH IS MORE THAN A COMPANY'S KEY DOES ─────────────────
 *
 * **The whole of the person's own keys at that site**: their vote on every
 * company they approve payments for there, not only the ability to read. A
 * company's key still opens that company's records and no other; this key is
 * not a company's key, and the screen that gives it says what it gives.
 */

/* The domain this expansion lives in. The day it changes, every person's saved
 * keys at every site stop opening, so it is a migration and never a patch. */
const KEYRING_SALT = new TextEncoder().encode('midnight-identity/keyring/v1');

/** One parent, one job. */
const KEYRING_PARENT_INDEX = 0;

/**
 * **THE SITE'S IDENTIFIER FOR A PERSON**, the same shape `request.ts` checks at
 * the parse, checked again here for the reason the origin is: a caller that
 * assembled an ask by hand never went through the parser.
 */
const PERSON = /^[A-Za-z0-9_-]{1,64}$/u;

declare const keyringBrand: unique symbol;

/** 32 bytes that open ONE person's saved keys at one site. Never a company's key, never an address. */
export type KeyringKey = Uint8Array & { readonly [keyringBrand]: true };

export const KEYRING_RELEASE_SCHEMA = 'midnight-identity/keyring-release/v1';

const personOf = (ask: KeyringRequest): string => {
  const person = ask.person;
  if (typeof person !== 'string' || !PERSON.test(person)) {
    throw new UnlockError(
      'person-not-usable',
      'this asks for the key your saved keys at a site are sealed under, and does not name '
      + 'you in a way this wallet can use. Nothing has been given.');
  }
  return person;
};

/**
 * THE KEYRING KEY. A pure function of the person's seed and the site's own
 * identifier for them. **The origin is checked and is not an ingredient; the
 * signed-in address is not read here at all** - it gates in `keyringReleaseFor`.
 */
export function keyringKeyFor(identity: Identity, ask: KeyringRequest): KeyringKey {
  originOf(ask);
  const person = personOf(ask);
  const parent = identity.authority(Purposes.Keyring, KEYRING_PARENT_INDEX);
  return hkdf(sha256, parent, KEYRING_SALT, new TextEncoder().encode(person), KEY_BYTES) as KeyringKey;
}

/**
 * WHAT CROSSES BACK FOR A KEYRING ASK.
 *
 * **`key` AND `companyKey` ARE SECRETS ON THE WIRE**, with the rules `key` has
 * above: posted to the observed origin and nowhere else, never written to
 * storage, a history entry, a URL or a log, and rendered by no screen.
 */
export interface KeyringRelease {
  readonly schema: typeof KEYRING_RELEASE_SCHEMA;
  /** OBSERVED. A convenience for the requester, never an authority. */
  readonly origin: string;
  /** Echoed back, never read as authority. */
  readonly person: string;
  readonly signedInAs: string | null;
  readonly company: string | null;
  readonly nonce: string;
  readonly at: number;
  /** Base64url of the 32-byte keyring key. **Do not log this. Do not store it.** */
  readonly key: string;
  /** Base64url of the 32-byte key for `company`, or null when no company was asked about. */
  readonly companyKey: string | null;
  /**
   * **PUBLIC.** The key this person sits on `company`'s vault committee with
   * (`committee-key.ts`), or null when no company was asked about. Its secret
   * half is not in this message and never leaves the wallet.
   */
  readonly committeeKey: SignatureVerifyingKey | null;
}

/**
 * **THE MESSAGE A PERSON'S PRESS PRODUCES FOR A KEYRING ASK, AND THE GATE IS
 * INSIDE IT.** `holds` answers whether one of this wallet's own accounts has
 * exactly the given address. When the ask names the address the page signed in
 * as and this wallet holds no account with it, **nothing is built and nothing
 * can be sent**: the screen's disabled button is not the only thing standing
 * between a second wallet in the browser and a key the page would seal a
 * person's first keys under.
 */
export function keyringReleaseFor(
  identity: Identity, ask: KeyringRequest, at: number,
  holds: (address: string) => boolean,
): KeyringRelease {
  const origin = originOf(ask);
  if (ask.signedInAs !== null && !holds(ask.signedInAs)) {
    throw new UnlockError(
      'address-not-held',
      `the page at ${origin} signed in as an address that none of this wallet's accounts has, `
      + 'so this is not the wallet it signed in with. A key from this wallet would not open '
      + 'anything saved there by the wallet that did, and anything saved under it could only '
      + 'ever be opened with this one. Nothing has been given.');
  }
  const key = keyringKeyFor(identity, ask);
  const companyKey = ask.company === null
    ? null
    : toBase64Url(unlockKeyFor(identity, {
      schema: ask.schema,
      kind: 'unlock',
      requester: ask.requester,
      purpose: ask.purpose,
      nonce: ask.nonce,
      expiresAt: ask.expiresAt,
      company: ask.company,
    }));
  return Object.freeze({
    schema: KEYRING_RELEASE_SCHEMA,
    origin,
    person: personOf(ask),
    signedInAs: ask.signedInAs,
    company: ask.company === null ? null : ask.company.toLowerCase(),
    nonce: ask.nonce,
    at,
    key: toBase64Url(key),
    companyKey,
    committeeKey: ask.company === null ? null : committeeKeyFor(identity, ask.company),
  });
}

export type KeyringRead =
  | {
    readonly ok: true;
    readonly key: Uint8Array;
    readonly companyKey: Uint8Array | null;
    /** Public, and present exactly when a company key is. */
    readonly committeeKey: SignatureVerifyingKey | null;
    readonly at: number;
  }
  | { readonly ok: false; readonly code: ReleaseFailure | 'person-mismatch'; readonly says: string };

const readKeyBytes = (value: unknown): Uint8Array | null => {
  if (typeof value !== 'string') return null;
  try {
    const bytes = fromBase64Url(value);
    return bytes.length === KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
};

/**
 * **THE REQUESTER'S SIDE OF A KEYRING RELEASE, AND IT READS NO EXPECTATION OUT
 * OF THE MESSAGE.** The origin is the recipient's own, the nonce the one it
 * issued, the person, the signed-in address and the company the ones it asked
 * about.
 *
 * **WHAT THESE COMPARISONS DO NOT PROVE, SAID HERE SO NOBODY RELIES ON IT:** a
 * wallet that echoed the address back without holding it would pass them. They
 * catch a release answering a different question. What stops a wallet that does
 * not hold the signed-in address is `keyringReleaseFor` on that wallet's side,
 * and what the page can check for itself is whether the key opens what is
 * already saved.
 */
export function readKeyringRelease(
  message: unknown,
  expecting: {
    readonly atOrigin: string;
    readonly expectingNonce: string;
    readonly person: string;
    readonly signedInAs: string | null;
    readonly forCompany: string | null;
  },
): KeyringRead {
  const body = message as KeyringRelease | null;
  if (typeof body !== 'object' || body === null || body.schema !== KEYRING_RELEASE_SCHEMA) {
    return { ok: false, code: 'not-a-release', says: 'that is not a released key.' };
  }
  if (body.origin !== expecting.atOrigin) {
    return {
      ok: false,
      code: 'origin-mismatch',
      says: `this key was released for ${String(body.origin)} and was received at `
        + `${expecting.atOrigin}. It is refused.`,
    };
  }
  if (body.person !== expecting.person || (body.signedInAs ?? null) !== expecting.signedInAs) {
    return {
      ok: false,
      code: 'person-mismatch',
      says: 'this key was released for a different person, or for a different signed-in address, '
        + 'from the one that was asked about. It is refused rather than used.',
    };
  }
  const wanted = expecting.forCompany === null ? null : expecting.forCompany.toLowerCase();
  const given = body.company === null || body.company === undefined
    ? null : String(body.company).toLowerCase();
  if (given !== wanted) {
    return {
      ok: false,
      code: 'company-mismatch',
      says: 'this answer carries a key for a different company from the one that was asked about, '
        + 'or for none. It is refused rather than used, because a key used against the wrong '
        + 'company seals records nobody can open again.',
    };
  }
  if (body.nonce !== expecting.expectingNonce) {
    return {
      ok: false,
      code: 'nonce-mismatch',
      says: 'this answers a different request from the one that was sent.',
    };
  }
  const key = readKeyBytes(body.key);
  if (key === null) {
    return { ok: false, code: 'unusable-key', says: `a released key is ${KEY_BYTES} bytes and that one is not.` };
  }
  let companyKey: Uint8Array | null = null;
  let committeeKey: SignatureVerifyingKey | null = null;
  if (wanted !== null) {
    committeeKey = readCommitteeKey(body.committeeKey);
    if (committeeKey === null) {
      return {
        ok: false,
        code: 'unusable-key',
        says: 'this answer gives a company key without the committee key that belongs beside it, '
          + 'or with one that is not a committee key. It is refused rather than used.',
      };
    }
    companyKey = readKeyBytes(body.companyKey);
    if (companyKey === null) {
      return {
        ok: false,
        code: 'unusable-key',
        says: `a released company key is ${KEY_BYTES} bytes and that one is not.`,
      };
    }
    /* The two keys are different derivations and are never the same bytes; an
     * answer that says they are has put one where the other belongs. */
    if (companyKey.every((byte, i) => byte === key[i])) {
      return {
        ok: false,
        code: 'unusable-key',
        says: 'this answer gives the same key for the company as for your saved keys, and they are '
          + 'never the same. It is refused rather than used.',
      };
    }
  } else if ((body.companyKey !== null && body.companyKey !== undefined)
    || (body.committeeKey !== null && body.committeeKey !== undefined)) {
    return {
      ok: false,
      code: 'company-mismatch',
      says: 'this answer carries a company key nobody asked for. It is refused rather than used.',
    };
  }
  if (typeof body.at !== 'number' || !Number.isSafeInteger(body.at)) {
    return { ok: false, code: 'not-a-release', says: 'that is not a released key.' };
  }
  return { ok: true, key, companyKey, committeeKey, at: body.at };
}

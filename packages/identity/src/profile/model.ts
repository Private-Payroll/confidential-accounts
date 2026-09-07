import { toBase64Url } from '../passkey/bytes.js';
import { check } from './definition.js';
import type { AttributeName } from './definition.js';
import type { AskKind } from './request.js';
import type { Registry } from './attributes.js';

/**
 * A PERSON'S OWN FACTS, AND WHO SAYS SO.
 *
 * ONE PROFILE PER ACCOUNT, NOT ONE PER SUBWALLET — decision 1, and §2 is
 * the reasoning kept. The eleven slots are one secret and one recovery set;
 * they are not separate identities and the chain cannot keep them apart. A
 * profile per slot would LOOK like eleven identities and would be believed,
 * which is that failure in a new place — an interface implying a protection
 * the mechanism does not provide. **What per-recipient control actually is, is
 * a GRANT** (§3.2), and that is what this file gives it.
 */

/* ------------------------------- provenance ------------------------------ */

/**
 * WHO SAYS SO. §3.1, and this is the most important type in the file.
 *
 * *"a legal name"* and *"not on a sanctions list"* are not the same kind of
 * fact. The
 * first is self-asserted and the recipient knows it. The second is worth
 * nothing unless an issuer signed it. **Retrofitting provenance into a store
 * that already holds real people's data is not a refactor** — it is a migration
 * of the most sensitive records this product will ever hold. So it is here from
 * the first commit, as a DISCRIMINATED UNION rather than a flag: there is no
 * value of this type that is a fact without a source.
 */
export type Assertion =
  | {
    readonly by: 'self';
    /**
     * §3.2b — WHAT THIS FIELD IS FOR, AND IT IS ARITHMETIC RATHER THAN POLICY.
     *
     * A signature is over what the issuer said. Editing the text does not edit
     * the signature, so an edited issued value is a FORGED one. Editing one
     * therefore drops it to self-asserted — **visibly, with the previous
     * assertion named**, which is what this field carries. `null` is the
     * ordinary case: a fact the person typed and nobody ever signed.
     */
    readonly formerly: { readonly issuer: string; readonly issuedAt: number } | null;
  }
  | {
    readonly by: 'issuer';
    /** Who signed it. An opaque identifier; nothing here knows any provider. */
    readonly issuer: string;
    readonly signature: string;
    /**
     * REQUIRED. §3.1: **an issued fact is dated or it is not evidence.** A
     * sanctions check from January is not evidence in August, and the
     * interface may never show a verified mark without the date beside it —
     * the same rule §7.12 already imposes on `rebuiltAt`.
     */
    readonly issuedAt: number;
    /**
     * ONE NULL, ONE MEANING: *the issuer set no expiry*. Never *this never
     * expires*. The issuer either set one or did not; there is no third state,
     * so the two-values rule is satisfied by there being one.
     */
    readonly expiresAt: number | null;
    /**
     * WHERE TO ASK AGAIN. §4: an issued attestation must never be the
     * wallet's ONLY copy. Self-typed facts are cheap to re-enter; a KYC
     * attestation cost money and time, and decision 4 says recovery does
     * NOT restore the profile. Without this field decision 4 quietly means
     * *lose your KYC when you lose your laptop*, which is not what was agreed.
     * `null` means the issuer gave no way back.
     */
    readonly reachableAt: string | null;
  }
  | {
    /**
     * **NOBODY SAID IT. THIS WALLET WORKED IT OUT.** See
     * `definition.ts`'s `Source`.
     *
     * A receiving address is not a claim about a person: it is a function of
     * their own keys and of the subwallet they picked on the approval screen,
     * computed at the moment of asking. **`by: 'self'` would be a lie of
     * exactly the kind this union exists to make impossible** — it would tell a
     * recipient the person TYPED this, when nothing they could type would
     * change it, and would make an edited value indistinguishable from a
     * computed one.
     *
     * **THERE IS NO SECOND FIELD ON THIS ARM AND THERE MUST NOT BE.** Not the
     * subwallet number, not the derivation path, not a label. The subwallet is
     * a choice the person made once, on one screen, for one recipient; putting
     * it in the signed payload would hand every recipient a slot INDEX to
     * compare notes on, which is the one thing choosing a slot per employer
     * exists to prevent.
     */
    readonly by: 'wallet';
  };

/** Whether an issued record has gone stale, as at a moment. */
export const isExpired = (assertion: Assertion, now: number): boolean =>
  assertion.by === 'issuer' && assertion.expiresAt !== null && now >= assertion.expiresAt;

/**
 * **WHETHER THIS RECORD IS ONE THE PERSON HOLDS.** One reader, one place.
 *
 * A derived value is never in `held`, so nothing that walks `held` can ever
 * produce one, and nothing that looks a `Sent` up in `held` may look one up.
 * `changed` below is the whole of what that protects and the reason this exists
 * as a named question rather than as `by === 'wallet'` written twice.
 */
export const wasDerived = (assertion: Assertion): boolean => assertion.by === 'wallet';

/* --------------------------- what a record says -------------------------- */

/**
 * §3.2c — **A CLAIM IS NOT A VALUE, AND AN ISSUER USUALLY SENDS A CLAIM.**
 *
 * Self-style providers return a signed RESULT, not the document behind it: not
 * *date of birth = 1990-04-02* but **over 18: true, proved on 12 Aug** — a
 * claim ABOUT an attribute whose subject the wallet may never hold at all.
 *
 * **THAT IS THE STRONGER POSITION AND THIS TYPE EXISTS SO THE MODEL CANNOT
 * FLATTEN IT.** A provider that hands over a data blob makes this wallet the
 * custodian of somebody's passport details. A provider that hands over a proof
 * does not — and a model that could only store VALUES would force somebody to
 * invent one: a date of birth we were never given, or a `verified: yes` field
 * with no subject.
 *
 * **A `predicate` record has no `value` field to fill in.** That is the whole
 * point: it is not discipline, it is the type.
 */
export type Says =
  | { readonly of: 'value'; readonly value: string }
  | { readonly of: 'predicate'; readonly predicate: string; readonly result: boolean };

/** One record the wallet holds. §3.1 and §3.2c, unified — see `about`. */
export interface Held {
  readonly id: string;
  /**
   * **THE ATTRIBUTE THIS IS ABOUT — which the wallet may hold no value for.**
   * §3.1 calls this field `attribute` and §3.2c calls it `about`; they are the
   * same field and `about` is the word that stays true when the record is a
   * claim rather than a value.
   */
  readonly about: AttributeName;
  readonly says: Says;
  /** The person's own word for it: "work", "personal". May be empty. */
  readonly label: string;
  readonly asserted: Assertion;
  /**
   * WHICH VERSION'S RULES THIS WAS STORED UNDER. §3.4: minting `version: 2`
   * leaves every value already stored under v1 READABLE rather than
   * retroactively invalid, and this is the field that makes that true.
   */
  readonly definitionVersion: number;
}

/** Everything one account holds. */
export interface Profile {
  readonly schema: 'midnight-identity/profile/v1';
  readonly held: readonly Held[];
  readonly grants: readonly Grant[];
  /**
   * **EVERY TIME A KEY WAS RELEASED, AND TO WHOM.**
   *
   * **ABSENT MEANS ONE THING: recorded before this wallet could release a
   * key** -- that is, before this change. It never means *the releases were lost*. The
   * shape is `signed`'s and `kind`'s exactly, and for the same reason: tolerant
   * to read, strict to write, so one-null-two-states cannot form.
   * `releasesOf` is the only reader and `recordRelease` the only writer.
   */
  readonly releases?: readonly Release[];
  readonly updatedAt: number;
}

/* --------------------------------- grants -------------------------------- */

export interface Recipient {
  /** OBSERVED, never claimed — §5.3. Nothing writes this from a payload. */
  readonly origin: string;
  readonly name: string;
  readonly rdns: string;
}

/**
 * WHAT ONE RECIPIENT MAY SEE. §3.2.
 *
 * **A GRANT NAMES VALUES, NOT ATTRIBUTES.** *"They may see my email"* is
 * ambiguous when a person holds two. *"They may see this one"* is not.
 */
export interface Grant {
  readonly recipient: Recipient;
  /** Which slot this relationship is about. */
  readonly subwallet: number;
  readonly values: readonly string[];
  readonly madeAt: number;
  /** APPEND-ONLY. Nothing in this file removes an entry. */
  readonly disclosures: readonly Disclosure[];
}

/**
 * WHAT WAS ACTUALLY SENT, AT THE TIME IT WAS SENT. §3.2b.
 *
 * **A HISTORY ENTRY RECORDS CONTENT, NEVER A POINTER TO A VALUE THE PERSON MAY
 * SINCE HAVE CHANGED.** Otherwise the wallet tells a person they disclosed
 * something they did not, which is a false statement about the one subject this
 * record exists to be true about.
 *
 * `id` is kept ALONGSIDE the content, not instead of it — it is what lets the
 * wallet say *three recipients hold a name you have since changed* (`changed`,
 * below). Naming the gap is the honest half of §6's no-revocation rule; the
 * wallet cannot close it and must never imply it can.
 *
 * **A DERIVED SEND HAS NO HELD RECORD, SO ITS `id` IS NOT ONE.** It
 * carries the attribute's own name instead, and **nothing ever looks it up**:
 * `changed` skips a send whose assertion is the wallet's, because a value the
 * person never held cannot be a value they have since changed. The provenance
 * is what makes that true — not the spelling of the id, which is a label for a
 * reader and not a key.
 */
export interface Sent {
  readonly id: string;
  readonly about: AttributeName;
  readonly says: Says;
  readonly asserted: Assertion;
}

/**
 * **THE EXACT BYTES THAT WERE SIGNED, AND WHY THEY ARE KEPT.**
 *
 * §5.4's signed payload is ALREADY a trustless attestation: anybody holding the
 * public key can verify that this person approved these attributes for this
 * origin. **The only thing a chain would add is a date nobody can backdate**,
 * and that extension — if it is ever built — is `hash(signed payload)` and
 * nothing else. §5.5 is explicit that this is not §4's problem and does not
 * solve it: anchoring proves a disclosure HAPPENED; it does not give a
 * recovered browser back the list of who was told.
 *
 * **WHAT THAT NEEDS FROM TODAY IS ONE FIELD.** If only the parsed fields are
 * kept, the payload has to be REBUILT to be hashed — and then it must be
 * canonically serialisable for ever, or a preimage can never be shown to match
 * an anchor and the scheme is dead on arrival. **Keeping the literal bytes is
 * simpler and strictly stronger**, which is the scope's own conclusion.
 *
 * NOTHING IS BUILT FOR A CHAIN. No contract, no root, no transaction, no hash.
 * A hash of these bytes is `sha256(fromBase64Url(bytes))` and needs nothing
 * further from this module.
 *
 * **AND THE BYTES ARE KEPT BESIDE THE FIELDS, NEVER INSTEAD OF THEM.** §3.2b
 * needs the fields — what was actually sent, readable without a decoder, so the
 * history screen can say it. The bytes are what an anchor needs. `recheck`
 * (`disclosure.ts`) is what stops the two drifting apart: it reads the payload
 * back OUT of the bytes, verifies the signature over them, and compares what
 * comes out with the fields stored beside them. **If those can disagree, the
 * entry is worse than not having them.**
 */
export interface SignedBytes {
  /** Base64url of EXACTLY what was signed. Not a re-serialisation. */
  readonly bytes: string;
  readonly signature: string;
  readonly verifyingKey: string;
  /** STATED, never defaulted — the connector's optional `scheme?` is the trap. */
  readonly scheme: 'schnorr';
}

export interface Disclosure {
  readonly at: number;
  readonly nonce: string;
  /**
   * **WHICH KIND OF ASK THIS WAS.**
   *
   * Without it a sign-in is recorded as a disclosure that sent nothing, and the
   * history screen has two different events wearing one sentence: *you signed
   * in* and *you were asked for four things and sent none of them*. Both are
   * real, both are normal, and telling a person the second when it was the
   * first is a false statement about the one subject this record exists to be
   * true about (§3.2b).
   *
   * **NULL MEANS ONE THING: recorded before there was more than one kind** —
   * that is, before this change, when every ask this wallet could answer was a
   * disclosure. It never means *the kind was lost*. The shape is `signed`'s
   * exactly, and for the same reason: tolerant to read, strict to write, so
   * one-null-two-states cannot form here.
   */
  readonly kind: AskKind | null;
  readonly sent: readonly Sent[];
  /** Declining an optional attribute is a normal outcome — §7 step 5. */
  readonly declined: readonly AttributeName[];
  /**
   * **NULL MEANS ONE THING: recorded by a wallet that did not keep the bytes**
   * — that is, before this change. It never means *the bytes were lost* and never
   * means *this was not signed*; every disclosure this wallet has ever made was
   * signed. An entry written from now on cannot have it: `recordDisclosure`
   * demands it, so the null is a fact about the past and not a door.
   *
   * There is a rule about one null standing for two states. This one has one
   * state, and the writer's type is what keeps it that way.
   */
  readonly signed: SignedBytes | null;
}

/**
 * What `recordDisclosure` accepts — the same entry with the bytes REQUIRED.
 *
 * The asymmetry is the point. Reading tolerates an old entry; writing a new one
 * without the bytes is a type error, so *the field is optional* can never
 * quietly become *nobody fills it in*.
 *
 * This change puts `kind` on the same footing, for the same reason.
 */
export type NewDisclosure =
  Omit<Disclosure, 'signed' | 'kind'>
  /*
   * **AN UNLOCK IS NOT WRITABLE HERE, AND THE TYPE IS WHAT SAYS SO.**
   * A `Disclosure` is *what was sent, and the bytes that were signed*. A
   * release sends no values and signs nothing, so writing one as a disclosure
   * would be the exact fault fixed one level up: **a different event wearing
   * the same words**, and this time it would also demand a signature that does
   * not exist. `Release` and `recordRelease` are the other record.
   *
   * READING stays tolerant -- `Disclosure.kind` is still `AskKind | null` -- so
   * an entry from a wallet that did write one is readable rather than a crash.
   */
  & { readonly signed: SignedBytes; readonly kind: Exclude<AskKind, 'unlock'> };

/**
 * **WHAT A RELEASED KEY LEAVES BEHIND, AND WHAT IT MUST NOT.**
 *
 * *Record that a key was released, to which origin, and when. That is the one
 * thing a person can be told afterwards and the only honest form of a history
 * here.* Three fields, and the interesting part of this type is what is missing
 * from it.
 *
 * **THE KEY IS NOT IN HERE. NEITHER IS ANYTHING DERIVED FROM IT.** Not the
 * bytes, not a base64 of them, not a hash. A hash would be a commitment that
 * lets whoever holds it CONFIRM a guessed or stolen key belongs to this person
 * and this site — a fact nobody here needs and one this record has no business
 * making available. THE RULE: *the key itself is never recorded.
 * Anywhere.*
 *
 * **AND THERE IS NO SUBWALLET FIELD**, because the key does not depend on one.
 * A record naming a slot would be this wallet implying the release was
 * per-slot, which is the same class — an interface asserting a separation the
 * mechanism does not provide.
 *
 * **APPEND-ONLY, AND IT CANNOT BE OTHERWISE.** §6: no revocation language,
 * anywhere. Removing a row would say a release was undone. Nothing undoes one.
 */
export interface Release {
  readonly at: number;
  readonly nonce: string;
  /** OBSERVED origin, plus the words the site used about itself. */
  readonly recipient: Recipient;
  /**
   * **WHICH COMPANY'S RECORDS THAT KEY OPENS.**
   *
   * A release used to be identified by the site it went to, because the site
   * was what the key belonged to. It is not any more: the key belongs to a
   * COMPANY, and the same company can legitimately be reached from a second
   * host -- that is the entire point of the change. So a row that named only
   * the host would no longer say what was given away.
   *
   * **AND THIS PAIR IS THE WHOLE OF THE REMEMBERED LIST.** `originsFor` reads
   * it to warn when a company is asked for from a host it has not been given
   * to before. **It is a convenience and never an input to any key**: a wallet
   * rebuilt from its seed alone, with no history at all, derives every one of
   * these keys identically. If it were an input, a recovery would stop opening
   * a company's records -- which is that defect arriving by a different door.
   */
  readonly company: string;
}

/**
 * EVERY RELEASE THIS PROFILE HOLDS -- and the one place the absent field
 * becomes an empty list, so no caller has to remember that it can be absent.
 */
export const releasesOf = (profile: Profile): readonly Release[] => profile.releases ?? [];

/**
 * **EVERY HOST THIS COMPANY'S KEY HAS ALREADY BEEN GIVEN TO.**
 *
 * The rule this implements: *the wallet remembers which origin asked for which
 * company, and warns on a new one.* This is the reader, in
 * first-given order, without repeats.
 *
 * **IT IS A CONVENIENCE AND NEVER A KEY INPUT, AND THAT IS A PROPERTY OF WHERE
 * IT IS CALLED FROM RATHER THAN A PROMISE.** `unlock.ts` takes an identity and
 * an ask and has no third argument, so there is no signature this list could
 * reach. Losing every release this profile holds costs a warning; it cannot
 * cost access, because nothing derived from it was ever an ingredient.
 *
 * **A COMPANY WITH NO ROWS IS NOT A REFUSAL.** A company legitimately moves
 * host, which is the whole reason the key stopped depending on one. An empty
 * list means *nothing to compare against*, and the screen proceeds normally.
 */
export const originsFor = (profile: Profile, company: string): readonly string[] => {
  const seen: string[] = [];
  for (const release of releasesOf(profile)) {
    if (release.company !== company) continue;
    if (!seen.includes(release.recipient.origin)) seen.push(release.recipient.origin);
  }
  return Object.freeze(seen);
};

/** Whether a recorded disclosure could be shown to match an anchor. §5.5. */
export const anchorable = (disclosure: Disclosure): boolean => disclosure.signed !== null;

/* -------------------------------- failures ------------------------------- */

export type ProfileFailure =
  | 'not-in-vocabulary'
  | 'value-refused'
  | 'only-one-allowed'
  | 'no-such-value'
  | 'not-self-assertable'
  | 'issuer-not-accepted'
  | 'a-claim-has-no-text'
  | 'issued-without-a-date';

export class ProfileError extends Error {
  readonly code: ProfileFailure;
  constructor(code: ProfileFailure, message: string) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

/* --------------------------------- making -------------------------------- */

const newId = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(12)));

export const emptyProfile = (now: number): Profile => Object.freeze({
  schema: 'midnight-identity/profile/v1' as const,
  held: Object.freeze([]),
  grants: Object.freeze([]),
  releases: Object.freeze([]),
  updatedAt: now,
});

const withHeld = (profile: Profile, held: readonly Held[], now: number): Profile =>
  Object.freeze({ ...profile, held: Object.freeze([...held]), updatedAt: now });

const definitionFor = (registry: Registry, about: AttributeName) => {
  const definition = registry.definitionOf(about);
  if (!definition) {
    throw new ProfileError(
      'not-in-vocabulary',
      `'${about}' is not an attribute this wallet knows. The vocabulary is ours and a `
      + 'requester cannot add to it.');
  }
  return definition;
};

/**
 * A FACT THE PERSON TYPED. §3.1, §3.2b.
 *
 * The rule that decides whether the text is acceptable comes from the
 * DEFINITION and nothing here knows what attribute it is checking.
 */
export function selfAssert(
  profile: Profile, registry: Registry,
  about: AttributeName, typed: string, label: string, now: number,
): Profile {
  const definition = definitionFor(registry, about);
  if (!definition.selfAssertable) {
    throw new ProfileError(
      'not-self-assertable',
      definition.source === 'derived'
        /* The honest sentence for the other reason. *Somebody else has to
         * say it* is true of an issued attribute and false of this one: nobody
         * says it at all, and telling a person to go and get it signed would
         * send them looking for a party that does not exist. */
        ? `${definition.render.label} is not something anybody states. This wallet works it `
          + 'out from your own keys when a company asks for it, and which wallet you choose '
          + 'is what decides the answer.'
        : `${definition.render.label} is not something you can state about yourself — it has `
          + 'to come from whoever is in a position to say it.');
  }
  const checked = check(definition, typed);
  if (!checked.ok) throw new ProfileError('value-refused', checked.says);

  const already = profile.held.filter((h) => h.about === about);
  if (!definition.multiple && already.length > 0) {
    throw new ProfileError(
      'only-one-allowed',
      `you hold one ${definition.render.label.toLowerCase()}; change it rather than adding `
      + 'a second.');
  }
  const held: Held = Object.freeze({
    id: newId(),
    about,
    says: Object.freeze({ of: 'value' as const, value: checked.value }),
    label: label.trim(),
    asserted: Object.freeze({ by: 'self' as const, formerly: null }),
    definitionVersion: definition.version,
  });
  return withHeld(profile, [...profile.held, held], now);
}

/**
 * A RECORD SOMEBODY ELSE SIGNED — a value OR a claim about an attribute this
 * wallet may hold no value for. §3.2c.
 *
 * **NOTHING IS BUILT FOR ANY ISSUER THIS CHANGE** (NOT THIS
 * CHANGE) and no provider's name appears anywhere in this repository. This is
 * the door such a thing would come through, built now so that the day one
 * arrives the model does not move — and exercised now by
 * `registry-open.test.ts` rather than left as a claim.
 */
export function recordIssued(
  profile: Profile, registry: Registry,
  about: AttributeName, says: Says, label: string,
  asserted: Extract<Assertion, { by: 'issuer' }>, now: number,
): Profile {
  const definition = definitionFor(registry, about);
  if (!Number.isFinite(asserted.issuedAt)) {
    throw new ProfileError(
      'issued-without-a-date',
      'an issued record carries the date it was issued, or it is not evidence.');
  }
  const accepted = definition.acceptedIssuers;
  if (accepted === null) {
    throw new ProfileError(
      'issuer-not-accepted',
      definition.source === 'derived'
        /* A signature over a derived value would be an issuer attesting to
         * arithmetic somebody else can do for themselves, and storing it would
         * put a copy in `held` that goes stale the moment a different subwallet
         * is chosen. */
        ? `nothing may be issued about ${definition.render.label.toLowerCase()}; it is `
          + 'worked out from your own keys and is not a fact anybody signs.'
        : `nothing may be issued about ${definition.render.label.toLowerCase()}; it is `
          + 'something you state yourself.');
  }
  if (accepted !== 'any' && !accepted.includes(asserted.issuer)) {
    throw new ProfileError(
      'issuer-not-accepted',
      `this wallet does not accept records about ${definition.render.label.toLowerCase()} `
      + `from ${asserted.issuer}.`);
  }
  /* A VALUE is still checked against the rule. A PREDICATE is not, because
   * there is no text to check — which is exactly §3.2c's point. */
  if (says.of === 'value') {
    const checked = check(definition, says.value);
    if (!checked.ok) throw new ProfileError('value-refused', checked.says);
  }
  const held: Held = Object.freeze({
    id: newId(),
    about,
    says: Object.freeze({ ...says }),
    label: label.trim(),
    asserted: Object.freeze({ ...asserted }),
    definitionVersion: definition.version,
  });
  return withHeld(profile, [...profile.held, held], now);
}

/* -------------------------------- editing -------------------------------- */

/**
 * **A PERSON CHANGES THEIR OWN VALUES WHENEVER THEY LIKE.** §3.2b. Type a new
 * name, it replaces the old one. Nothing versions, nothing is archived on their
 * behalf, and no screen makes them justify it.
 *
 * **THE ONE EXCEPTION IS AN ISSUER-SIGNED VALUE, AND IT IS NOT A POLICY — IT IS
 * ARITHMETIC.** The signature is over what the issuer said, so an edited issued
 * value is a forged one. Editing therefore DROPS IT TO SELF-ASSERTED, with the
 * previous assertion named. A screen that let somebody edit a verified value
 * and kept the verified mark would be the product lying on an issuer's behalf.
 *
 * **AND EDITING A VALUE NEVER REWRITES A PAST DISCLOSURE** — grants are not
 * touched here, and `Sent` carries content rather than a pointer, so a history
 * entry cannot change when a value does.
 */
export function editValue(
  profile: Profile, registry: Registry, id: string, typed: string, now: number,
): Profile {
  const existing = profile.held.find((h) => h.id === id);
  if (!existing) throw new ProfileError('no-such-value', 'there is no such value to change.');
  if (existing.says.of !== 'value') {
    throw new ProfileError(
      'a-claim-has-no-text',
      'that is a claim somebody proved about you, not something with text in it. It cannot '
      + 'be edited — it can only be proved again.');
  }
  const definition = definitionFor(registry, existing.about);
  const checked = check(definition, typed);
  if (!checked.ok) throw new ProfileError('value-refused', checked.says);

  const asserted: Assertion = existing.asserted.by === 'issuer'
    ? Object.freeze({
      by: 'self' as const,
      formerly: Object.freeze({
        issuer: existing.asserted.issuer, issuedAt: existing.asserted.issuedAt,
      }),
    })
    : existing.asserted;

  const next: Held = Object.freeze({
    ...existing,
    says: Object.freeze({ of: 'value' as const, value: checked.value }),
    asserted,
  });
  return withHeld(profile, profile.held.map((h) => (h.id === id ? next : h)), now);
}

/** The person's own word for a value — a label is not a fact and never
 * touches provenance. */
export function relabel(profile: Profile, id: string, label: string, now: number): Profile {
  const existing = profile.held.find((h) => h.id === id);
  if (!existing) throw new ProfileError('no-such-value', 'there is no such value to label.');
  return withHeld(
    profile,
    profile.held.map((h) => (h.id === id ? Object.freeze({ ...h, label: label.trim() }) : h)),
    now);
}

/**
 * REMOVING A VALUE REMOVES IT FROM WHAT IS HELD AND FROM EVERY GRANT — and
 * **leaves every disclosure history untouched**, because what was sent was
 * sent. §6: no revocation language, anywhere.
 */
export function forgetValue(profile: Profile, id: string, now: number): Profile {
  if (!profile.held.some((h) => h.id === id)) {
    throw new ProfileError('no-such-value', 'there is no such value to remove.');
  }
  return Object.freeze({
    ...profile,
    held: Object.freeze(profile.held.filter((h) => h.id !== id)),
    grants: Object.freeze(profile.grants.map((g) => Object.freeze({
      ...g, values: Object.freeze(g.values.filter((v) => v !== id)),
    }))),
    updatedAt: now,
  });
}

/* --------------------------- grants and history -------------------------- */

const sameRecipient = (a: Recipient, b: Recipient): boolean =>
  a.origin === b.origin && a.rdns === b.rdns;

/** What a recipient may see, remembered. A grant PRE-TICKS a box; §6 says it
 * may never skip the screen, and nothing in this file shows a screen. */
export function grantTo(
  profile: Profile, recipient: Recipient, subwallet: number,
  values: readonly string[], now: number,
): Profile {
  for (const id of values) {
    if (!profile.held.some((h) => h.id === id)) {
      throw new ProfileError('no-such-value', `nothing held here has the id '${id}'.`);
    }
  }
  const existing = profile.grants.find(
    (g) => sameRecipient(g.recipient, recipient) && g.subwallet === subwallet);
  const grant: Grant = existing
    ? Object.freeze({ ...existing, recipient, values: Object.freeze([...values]) })
    : Object.freeze({
      recipient, subwallet, values: Object.freeze([...values]), madeAt: now,
      disclosures: Object.freeze([]),
    });
  const grants = existing
    ? profile.grants.map((g) => (g === existing ? grant : g))
    : [...profile.grants, grant];
  return Object.freeze({ ...profile, grants: Object.freeze(grants), updatedAt: now });
}

/**
 * **APPEND-ONLY, AND THE ONLY HONEST THING THE HISTORY SCREEN CAN OFFER.**
 * §3.2. It cannot show what a recipient still holds. It can show exactly what
 * left and when.
 */
export function recordDisclosure(
  profile: Profile, recipient: Recipient, subwallet: number,
  disclosure: NewDisclosure, now: number,
): Profile {
  const existing = profile.grants.find(
    (g) => sameRecipient(g.recipient, recipient) && g.subwallet === subwallet);
  const base: Grant = existing ?? Object.freeze({
    recipient, subwallet, values: Object.freeze([]), madeAt: now,
    disclosures: Object.freeze([]),
  });
  const grant: Grant = Object.freeze({
    ...base,
    disclosures: Object.freeze([...base.disclosures, Object.freeze(disclosure)]),
  });
  const grants = existing
    ? profile.grants.map((g) => (g === existing ? grant : g))
    : [...profile.grants, grant];
  return Object.freeze({ ...profile, grants: Object.freeze(grants), updatedAt: now });
}

/**
 * **A KEY WAS RELEASED. APPEND-ONLY, AND IT TOUCHES NOTHING ELSE.**
 *
 * It does not call `grantTo` and it does not build a grant. **A grant is what a
 * site may SEE, and an unlock agrees to nothing new about a person's values**
 * -- it was found that calling `grantTo` with a sign-in's empty list silently
 * erased what somebody had already agreed a site may see, and this is the same
 * trap one kind further along. A release changes what a site can DO and nothing
 * about what it may be shown, so it goes in its own list and leaves the grants
 * exactly as they were.
 */
export function recordRelease(profile: Profile, release: Release, now: number): Profile {
  return Object.freeze({
    ...profile,
    releases: Object.freeze([...releasesOf(profile), Object.freeze(release)]),
    updatedAt: now,
  });
}

export interface Stale {
  readonly recipient: Recipient;
  readonly subwallet: number;
  readonly about: AttributeName;
  /** What they were given. */
  readonly theyHold: Says;
  /** What it says now — or `null` if the person has since removed it. */
  readonly itNowSays: Says | null;
  readonly sentAt: number;
}

const saysDiffer = (a: Says, b: Says): boolean => (
  a.of !== b.of
  || (a.of === 'value' && b.of === 'value' && a.value !== b.value)
  || (a.of === 'predicate' && b.of === 'predicate'
    && (a.predicate !== b.predicate || a.result !== b.result)));

/**
 * **WHAT THE WALLET CAN HONESTLY SAY ABOUT A CHANGED VALUE, AND WHAT IT MUST
 * NOT.** §3.2b.
 *
 * It can compare what it SENT with what a value says now and tell the person
 * *three recipients hold a name you have since changed*. **It cannot update
 * them and must never imply it can** — naming the gap is the honest half of
 * §6's no-revocation rule, and it is the same shape as the securing screen
 * saying which pieces have never been checked.
 */
export function changed(profile: Profile): readonly Stale[] {
  const now = new Map(profile.held.map((h) => [h.id, h.says] as const));
  const out: Stale[] = [];
  for (const grant of profile.grants) {
    for (const disclosure of grant.disclosures) {
      for (const sent of disclosure.sent) {
        /*
         * **A DERIVED VALUE WAS NEVER HELD, SO IT CANNOT HAVE CHANGED.**
         * Without this line every receiving address ever disclosed would be
         * reported for ever as *a value you have since removed*, because no
         * `held` record has its id and there never was one. That is the screen
         * telling a person something untrue about the one subject this record
         * exists to be true about (§3.2b) — and it would be the loudest thing
         * on it, once per company they are paid by.
         */
        if (wasDerived(sent.asserted)) continue;
        const current = now.get(sent.id) ?? null;
        if (current === null || saysDiffer(sent.says, current)) {
          out.push(Object.freeze({
            recipient: grant.recipient,
            subwallet: grant.subwallet,
            about: sent.about,
            theyHold: sent.says,
            itNowSays: current,
            sentAt: disclosure.at,
          }));
        }
      }
    }
  }
  return Object.freeze(out);
}

/** Every record about one attribute, in the order they were added. */
export const heldAbout = (profile: Profile, about: AttributeName): readonly Held[] =>
  profile.held.filter((h) => h.about === about);

export const heldById = (profile: Profile, id: string): Held | null =>
  profile.held.find((h) => h.id === id) ?? null;

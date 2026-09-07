import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Purposes } from '../keys/derivation.js';
import type { Identity } from '../keys/derivation.js';

/**
 * SEALING AN ACCEPTANCE TO A COMPANY'S INBOX.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * §5, decided 22 Aug: *"AND THE ADDRESS NEVER REACHES US EITHER. The acceptance
 * seals it to the company's inbox key on the employee's own device. Which means
 * the fingerprint is computed on the ADMIN'S machine, not ours -- if we
 * computed it we would need the address, and the leak returns through the door
 * this section builds."*
 *
 * **A JOIN THAT ANSWERED WITH AN ORDINARY `DisclosureResponse` WOULD BE A
 * WORKING PATH THAT LEAKS, AND IT WOULD LOOK FINISHED.** That is the whole
 * reason a round scoped to *one ask kind and the screen that renders it* also
 * contains a cipher: the kind cannot be answered at all without one, and the
 * only other way to answer is the way the agreement forbids.
 *
 * ── THE WIRE CONTRACT. NOT OURS, AND WRITTEN DOWN BECAUSE NOTHING CHECKS IT ─
 *
 * **The consuming code is in the OTHER repository and it already exists**, so
 * every choice below is a description of what that code reads, not a design.
 * **Nothing in either repository fails when the two disagree** -- an acceptance
 * sealed in the wrong shape is a ciphertext that will not open, discovered by a
 * person whose employer cannot pay them. So it is stated here, field by field,
 * and the same statement is recorded for the change.
 *
 * **IN, on the ask** (`JoinRequest`, `request.ts`):
 *
 *   `inboxPublicKey`  X25519 public key. **Lowercase hex, 64 characters.**
 *                     The reader decodes it with `fromHex`. Named in full --
 *                     it is what the other repository's account type calls it.
 *
 * **OUT, on the answer** (`SealedAcceptance` below). Four fields the reader
 * reads, **every one lowercase hex**:
 *
 *   `ephemeral`  our ephemeral X25519 public key, 32 bytes.
 *   `iv`         12 random bytes.
 *   `body`       the AES-GCM ciphertext.
 *   `tag`        **the empty string.**
 *
 * ── THE THREE PLACES THE INSTINCT HERE IS WRONG ───────────────────────────
 *
 * **1. THE ENCODING IS HEX AND THIS REPOSITORY'S CONVENTION IS BASE64URL.**
 * `recovery/locks.ts` publishes X25519 public keys as base64url and
 * `passkey/bytes.ts` exists to do it. Following the local convention here would
 * produce a field of the right length, in the wrong alphabet, that the reader's
 * `fromHex` would reject or -- worse -- mis-decode. **Where two repositories
 * disagree about an encoding, the wire follows the READER.**
 *
 * **2. `tag` IS EMPTY AND THAT IS NOT A BUG TO FIX.** The reader's `seal()`
 * emits `''` and its `unseal()` never reads the field. AES-GCM's authentication
 * tag is the last sixteen bytes of what an implementation returns from
 * `encrypt`, so it is already inside `body` -- for `@noble/ciphers`'s `gcm` as
 * for WebCrypto, which is what the other side uses. **A tag put in `tag` would
 * be a difference the reader's parser cannot notice**, because it does not look
 * at the field, and the ciphertext would then carry sixteen bytes the reader
 * would hand to its own decrypt as though they were message. Emit `''`.
 *
 * **3. THE KEY IS THE DIGEST'S BYTES, NOT THE DIGEST'S SPELLING.** The reader
 * derives `sha256(shared)` and holds it as hex; the AES key is the thirty-two
 * BYTES that hex spells. Feeding the sixty-four ASCII characters to AES would
 * be a sixty-four byte key, which is not an AES key length at all -- so this is
 * the one of the three that fails loudly rather than quietly.
 *
 * ── WHAT IS SEALED, AND WHY IT IS NOT A NEW OBJECT ────────────────────────
 *
 * The plaintext is the JSON of the very `DisclosureResponse` a disclosure
 * answers with -- same payload, same preimage, same signature, same
 * `verifyingKey`. **The argument, one layer out:** the far side, once it has
 * unsealed, runs the verifier it already has over the object it already knows,
 * and this change adds nothing new for anybody to verify. An acceptance is a
 * disclosure that travelled inside an envelope.
 *
 * ── WHAT THIS DOES NOT DO, SAID RATHER THAN LEFT TO BE FOUND ──────────────
 *
 * **It does not bind the ciphertext to the recipient**, and `recovery/locks.ts`
 * -- this repository's other sealing -- does: it puts both public keys into the
 * HKDF `info`, so a sealed value cannot be re-pointed at a different recipient
 * by somebody who can edit storage. **The reader's derivation is
 * `sha256(shared)` and has no room for an `info`**, so that property is not
 * available here without changing code in the other repository. It is a real
 * difference between the two seals in this wallet and it is recorded as one:
 * an acceptance is bound to the inbox key it was sealed to by the fact that
 * only that key's holder can open it, and by nothing else.
 *
 * **It cannot tell whose key it was handed.** The shape is checked at the
 * parser; whether the key belongs to the company on the page is unknowable
 * here and is said on the screen instead, in those words.
 */

/** The reader's field names, and this is the whole of the envelope. */
export const ACCEPTANCE_SCHEMA = 'midnight-identity/join-acceptance/v1';

const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface SealedAcceptance {
  /**
   * **AN ADDITION TO THE FOUR, AND THE READER IGNORES IT.**
   *
   * Every other message this wallet posts carries a `schema`, and the window a
   * join is answered in also carries refusals (`disclosure-refused/v1`), so
   * something has to tell them apart on our own side. An extra key on a JSON
   * object the reader destructures four fields out of costs nothing there.
   * **Omitting one of the four would be fatal; adding a fifth is not**, which
   * is the only reason this is a safe departure from a contract that is not
   * ours.
   */
  readonly schema: typeof ACCEPTANCE_SCHEMA;
  /** Lowercase hex, 32 bytes. */
  readonly ephemeral: string;
  /** Lowercase hex, 12 bytes. */
  readonly iv: string;
  /** **The empty string.** See the header: the reader emits and expects `''`. */
  readonly tag: string;
  /** Lowercase hex. AES-GCM ciphertext, the authentication tag inside it. */
  readonly body: string;
}

/**
 * **NAMED `Inbox…` AND NOT `Seal…`, AND THAT IS NOT A STYLE CHOICE.**
 * `profile/seal.ts` already exports `SealError` and `SealFailure` for the
 * wallet's OWN sealing -- the sealed blob a profile lives in -- and
 * `profile/index.ts` re-exports both modules. Two different failures under one
 * name is that shape at the level of an identifier, and here it would put a
 * refusal about a stranger's key and a refusal about this person's own storage
 * behind the same `catch`.
 */
export type InboxFailure =
  | 'not-an-inbox-key'
  | 'will-not-agree'
  /* The direction back. Each is its own code because each is a different
   * fact about one item, and the whole lesson is that facts about why
   * something is not on a list must not be merged. */
  | 'not-a-sealed-item'
  | 'will-not-open'
  | 'not-a-notice';

export class InboxError extends Error {
  readonly code: InboxFailure;
  constructor(code: InboxFailure, message: string) {
    super(message);
    this.name = 'InboxError';
    this.code = code;
  }
}

/**
 * SEAL ONE ACCEPTANCE TO ONE INBOX KEY.
 *
 * **IT THROWS RATHER THAN RETURNING SOMETHING UNSEALED**, and the caller is
 * written for that: `screens/approve.tsx` seals BEFORE it answers, before it
 * writes a grant and before it writes a history entry, so a refusal here means
 * nothing crossed and nothing was written down. There is no arm of this
 * function that returns a value the person's address is readable in.
 *
 * The parser has already checked the key's shape, and this checks it again --
 * not as belt and braces but because this is an exported door and the day
 * something else calls it, the check must be in the function rather than in
 * that caller's memory. The same shape.
 */
export function sealToInbox(plaintext: string, inboxPublicKey: string): SealedAcceptance {
  if (!/^[0-9a-fA-F]{64}$/u.test(inboxPublicKey)) {
    throw new InboxError(
      'not-an-inbox-key',
      `an inbox key is ${KEY_BYTES} bytes written as ${KEY_BYTES * 2} hex characters, `
      + `and that one is ${inboxPublicKey.length} characters. Nothing has been sealed.`);
  }
  const theirPublic = hexToBytes(inboxPublicKey.toLowerCase());
  const ephemeral = x25519.keygen();
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(ephemeral.secretKey, theirPublic);
  } catch (e) {
    /*
     * **A WELL-SHAPED KEY THAT IS NOT A POINT ON THE CURVE.** X25519 refuses a
     * small-order public key, and sixty-four hex characters is not proof of a
     * usable one. The refusal is named rather than left to reach a screen as a
     * library's sentence.
     */
    throw new InboxError(
      'will-not-agree',
      'that inbox key is the right length and this wallet cannot agree a secret with '
      + `it: ${(e as Error).message}. Nothing has been sealed and nothing has been sent.`);
  }
  /* THE BYTES OF THE DIGEST, NOT ITS SPELLING. The header's third instinct. */
  const key = sha256(shared);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = gcm(key, iv).encrypt(new TextEncoder().encode(plaintext));
  return Object.freeze({
    schema: ACCEPTANCE_SCHEMA,
    ephemeral: bytesToHex(ephemeral.publicKey),
    iv: bytesToHex(iv),
    /* THE READER EMITS `''` AND NEVER READS IT. Not a placeholder to fill in. */
    tag: '',
    body: bytesToHex(body),
  });
}


/* ══════════════════════════════════════════════════════════════════════════
 * THE DIRECTION BACK. THE POLLED INBOX.
 * Decided 27 Aug 2026.
 *
 * ── THE BOUNDARY. READ THIS BEFORE CHANGING ANYTHING BELOW IT ─────────────
 *
 * **AN OBSERVED ORIGIN CANNOT BE PRODUCED BY A CHANNEL NOBODY OPENED. AN
 * INBOX ITEM THEREFORE CARRIES NO ASK. ANYTHING THAT WOULD BECOME ONE IS
 * REACHED BY GOING TO THE ORIGIN, WHERE THE BROWSER SUPPLIES THE FACT.**
 *
 * `request.ts:180` states the property this rests on: `requester.origin` is
 * *"OBSERVED. Put here by the parser from its own argument"* — `channel.ts:128`
 * hands `parseAsk` `MessageEvent.origin`, which the browser fills in and no page
 * can write. **It is the only field in this protocol that is a FACT rather than
 * a CLAIM**, and everything downstream is built on it being unforgeable:
 * `screens/approve.tsx:383` chooses which wallet slot the person is offered from
 * it (`slot-choice.ts`), `:390` decides which remembered grant pre-ticks, `:488`
 * signs it into the payload `mint` produces, `:607` writes it into the history,
 * and thirty-odd sites print it as the largest true words on the screen.
 *
 * **A NOTICE HAS NO SUCH FIELD AND MUST NOT BE ALLOWED TO SUPPLY ONE.** Handing
 * `parseAsk` an origin a sender wrote into a sealed blob would launder a claim
 * into the one field the protocol treats as a fact — and it would do it
 * invisibly, because every reader downstream would go on reading the field it
 * has always read.
 *
 * Two alternatives were designed and refused on 27 Aug, and both are recorded
 * because the next round will be tempted by them:
 *
 *   · **PROVENANCE ON THE ASK** — `from: {of: 'window', origin} | {of: 'inbox'}`
 *     makes the distinction expressible in the type, and then every one of those
 *     thirty sites has to consult it correctly, for ever, including sites written
 *     by people who never read this comment. The failure is silent and it fails
 *     the wrong way: a site that forgets treats a claim as observed. **A safety
 *     property that depends on thirty correct reads is not a property.**
 *   · **KEYING AN INBOX ASK ON THE COMPANY** (the `company` field, already claimed and
 *     shape-checked) invents a SECOND identity for an ask, leaving two answers to
 *     *who is asking* that must never disagree. That is a protocol change and it
 *     belongs in a scope, not in a round that was not asked to design one.
 *
 * **THE PRESSURE TO ERODE THIS IS PREDICTABLE AND IT SOUNDS REASONABLE:** *the
 * person is already looking at the item, why make them navigate.* Because the
 * navigation is what produces the fact. There is no other source of it.
 *
 * ── WHAT AN ITEM IS, THEN ─────────────────────────────────────────────────
 *
 * **A SEALED NOTICE THAT SOMETHING AWAITS.** The agreement names three:
 * *"a second company inviting you, a proposal awaiting your approval, being
 * seated as a signer."* A notice tells the person. It is not the thing itself,
 * and it approves nothing. Acting on one takes the person to the company's own
 * page, where the browser fills in the observed origin and the approval path
 * already built runs unchanged — **nothing new approves anything, and there is no
 * second surface where things are approved because there is no second thing
 * that approves.**
 *
 * **ALL THREE KINDS EXIST NOW rather than one with room for the others.** The
 * notice shape does not vary by kind: the difference is one sentence, held in a
 * table on the screen. A single-valued `kind` would make the second kind a
 * schema change, and would leave the third thing the agreement names to be
 * rediscovered by whoever builds it. Three values settle the schema; a fourth
 * kind is a row.
 *
 * ── THE WIRE CONTRACT. OURS, UNILATERAL, AND WRITTEN DOWN FOR THAT REASON ──
 *
 * **THE EARLIER CONTRACT WAS A DESCRIPTION OF CODE THAT ALREADY EXISTED. THIS ONE IS
 * NOT.** There is no inbox host anywhere: no URL in `app/config.ts`, no entry in
 * `.env.example`, and nothing in the other repository answers any of this. So
 * every field below is a shape agreed with nobody, and the same statement is in
 * recorded for the change. **Nothing in either repository
 * fails when the two disagree** — the failure is an item that will not open,
 * reported to a person who cannot act on what they cannot see.
 *
 * **THE TRANSPORT IS A DEPENDENCY AND NOT A URL** (`InboxHost` below). A
 * configured address for a host that does not exist would be a value naming
 * nothing, committed to a repository going public, that later work has to
 * find and change. The caller supplies the transport; this build supplies none,
 * and the card says exactly that rather than showing an empty list.
 *
 * **WHAT A REAL TRANSPORT MUST SATISFY**, so the change that writes one inherits
 * it rather than deriving it:
 *
 *   1. It answers `InboxAsk` with `InboxAnswer` and nothing else. **It is a
 *      relay of sealed blobs and it is never trusted for anything but
 *      availability** — every field it can influence is either ciphertext or is
 *      treated here as the host's own claim.
 *   2. **It must not need a viewing key, a signature, or any proof of who is
 *      asking.** Anyone may ask for anyone's inbox; that is what makes the
 *      inbox key the only secret in the exchange. A host that authenticated the
 *      asker would learn the asker.
 *   3. **It answers over HTTPS to an origin the person can be told.** The screen
 *      names the host, so the transport must be able to say what it is
 *      (`InboxHost.describes`).
 *   4. **It is polled and never pushed.** *"A WEB PAGE CANNOT BE PUSHED TO"* —
 *      no service worker, no socket that outlives the unlocked phase.
 *
 * **IN, on the ask** (`InboxAsk`):
 *
 *   `schema`  `'midnight-identity/inbox-ask/v1'`.
 *   `inbox`   the person's inbox public key, **lowercase hex, 64 characters** —
 *             an X25519 public key, `Purposes.Inbox` index 0. **It is ONE
 *             address for the whole person and it is the same address every
 *             company writes to**, so the host can tell that everything written
 *             to it is written to one person. That is the cost the screen names,
 *             and it is precisely what the opaque-per-company round removes.
 *   `after`   optional. An opaque cursor from a previous answer, or absent for
 *             everything the host holds. **Opaque means this wallet never reads
 *             it** — it is the host's bookmark, echoed back unexamined, so a
 *             host that encodes something in it learns nothing it did not
 *             already know.
 *
 * **OUT, on the answer** (`InboxAnswer`): `schema`, `items`, and an optional
 * `cursor`. Each item is a `SealedItem`:
 *
 *   `id`         the host's own identifier for the item. **PLAINTEXT, AND THE
 *                HOST CHOSE IT.** It exists so an item that cannot be opened can
 *                be named to a person and so the same item is not reported
 *                twice. **It is never rendered as content and never trusted as
 *                one** — it is shown, when it is shown at all, as what it is: a
 *                reference the host made up.
 *   `ephemeral`  the sender's ephemeral X25519 public key, 32 bytes, lowercase hex.
 *   `iv`         12 bytes, lowercase hex.
 *   `tag`        **the empty string**, for the same reason `SealedAcceptance`
 *                carries one: the authentication tag is the last sixteen bytes of
 *                what AES-GCM returns from `encrypt`, so it is already inside
 *                `body`. A sender that fills this field has put the tag in two
 *                places and truncated neither, and the body will not
 *                authenticate — which is why `openFromInbox` names the field in
 *                that failure instead of leaving a person with *could not open*.
 *   `body`       the AES-GCM ciphertext, lowercase hex.
 *
 * **THE FOUR ARE `SealedAcceptance`'S FOUR, IN THE SAME ALPHABET, WITH THE SAME
 * DERIVATION** — `sha256(shared)` held as bytes, never as its spelling. One
 * envelope shape travels both ways through this wallet. Two would be a disagreement at
 * the level of a wire format, and the cost of one is a field that is always the
 * empty string.
 *
 * **THE PLAINTEXT IS A `Notice`**, JSON, and it is the whole of what a sender
 * may say. Every field in it is the sender's own words:
 *
 *   `schema`  `'midnight-identity/inbox-notice/v1'`.
 *   `kind`    one of `NOTICE_KINDS` — the three the agreement names.
 *   `at`      when the sender says it made this. **CLAIMED.** Sealing keeps the
 *             host from writing it; it does not keep the sender from lying, and
 *             the screen shows it as *said* rather than as *happened*.
 *   `from`    `{ name, rdns }` — the sender's own words about itself, shown as
 *             TEXT and never as markup, exactly as `Asking.requester.name` is.
 *   `where`   the origin the person goes to in order to act. **CLAIMED, checked
 *             for SHAPE and for nothing else**, and this wallet does not link to
 *             it: it is rendered whole, monospace, beside a copy control, which
 *             is what `screens/approve.tsx` already does with an origin and for
 *             a stronger reason here — a wallet that offers a button to a
 *             stranger's address is a wallet that helps somebody land on the
 *             wrong one.
 *   `says`    optional. One sentence, the sender's words, text.
 *
 * **THERE IS NO FIELD IN `SealedItem` THAT A NOTICE'S WORDS COULD RIDE IN**, and
 * that is the refusal *"no notification content readable by the server"* made
 * structural rather than promised. `inbox.test.ts` seals a notice carrying a
 * distinctive string and asserts that string appears nowhere in the envelope's
 * JSON — an item the host can read is not a notification, it is a broadcast.
 * ══════════════════════════════════════════════════════════════════════════ */

/** The one inbox this change asks at. See the boundary above: ONE per person. */
export const INBOX_INDEX = 0;

export const INBOX_ASK_SCHEMA = 'midnight-identity/inbox-ask/v1';
export const INBOX_ANSWER_SCHEMA = 'midnight-identity/inbox-answer/v1';
export const NOTICE_SCHEMA = 'midnight-identity/inbox-notice/v1';

/**
 * THE THREE THINGS THE AGREEMENT NAMES.
 *
 * *"Everything after — a second company inviting you, a proposal awaiting your
 * approval, being seated as a signer — is a notification in the wallet."*
 *
 * **THE ORDER IS NOT READ OUT ANYWHERE**, unlike `ASK_KINDS`, whose order is the
 * order `namedKinds` reads it in onto a screen. Each kind's sentence is looked
 * up by name in one table (`app/inbox-card.tsx`), so a kind added here without a
 * sentence fails a test rather than rendering a blank.
 */
export const NOTICE_KINDS = ['invitation', 'proposal', 'seat'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * WHAT A SENDER MAY SAY. Every field is the sender's, and none is observed.
 *
 * **`where` IS AN ORIGIN AND NOT A LINK, AND `at` IS A CLAIM AND NOT AN EVENT.**
 * Both are said that way on the screen. See the boundary block above.
 */
export interface Notice {
  readonly schema: typeof NOTICE_SCHEMA;
  readonly kind: NoticeKind;
  /** CLAIMED. Milliseconds. The sender's own clock. */
  readonly at: number;
  /** CLAIMED. The sender's own words about itself. Rendered as text, never markup. */
  readonly from: { readonly name: string; readonly rdns: string };
  /** CLAIMED. An `https:` origin, whole, checked for shape only. Never linked. */
  readonly where: string;
  /** CLAIMED, optional. One sentence, the sender's words. Text. */
  readonly says?: string;
}

/**
 * ONE ITEM AS IT LIES ON THE HOST. Four sealed fields and an identifier the
 * host chose. See the contract above for every one of them.
 */
export interface SealedItem {
  /** PLAINTEXT, and the host's own. Never content. */
  readonly id: string;
  /** Lowercase hex, 32 bytes. */
  readonly ephemeral: string;
  /** Lowercase hex, 12 bytes. */
  readonly iv: string;
  /** **The empty string.** The tag is inside `body`. */
  readonly tag: string;
  /** Lowercase hex. AES-GCM ciphertext, the authentication tag inside it. */
  readonly body: string;
}

export interface InboxAsk {
  readonly schema: typeof INBOX_ASK_SCHEMA;
  /** Lowercase hex, 64 characters. ONE per person, this change. */
  readonly inbox: string;
  /** Opaque to this wallet. Echoed back, never read. */
  readonly after?: string;
}

export interface InboxAnswer {
  readonly schema: typeof INBOX_ANSWER_SCHEMA;
  readonly items: readonly SealedItem[];
  /** Opaque to this wallet. Handed back as `after` next time. */
  readonly cursor?: string;
}

/**
 * THE TRANSPORT, AS A DEPENDENCY. **There is no implementation of this in this
 * repository and that is deliberate** — see the contract above. A caller with a
 * real host supplies one; `app/inbox-live.ts` supplies none, and the card says
 * so rather than showing a person an empty list.
 */
export interface InboxHost {
  /** What a person is told the host is. An origin, for the screen's sentence. */
  readonly describes: string;
  items(ask: InboxAsk): Promise<InboxAnswer>;
}

/**
 * THE KEYPAIR AN ITEM IS SEALED TO.
 *
 * **`recovery/locks.ts:81` IS THE CONSTRUCTION AND THIS MIRRORS IT** — an
 * x25519 keypair off an authority purpose, the public half published, the
 * secret half produced from the identity every time rather than stored, which
 * is the whole point of a derived key: there is nothing to back up and nothing
 * to lose.
 *
 * **IT PUBLISHES LOWERCASE HEX AND `recoveryKeypair` PUBLISHES BASE64URL, AND
 * THAT DIFFERENCE IS ON PURPOSE.** This file's header states the rule it comes
 * from: the wire follows the reader. A recovery key is read by another instance
 * of this wallet, so it follows this repository's convention; an inbox key is
 * read by whatever writes to a person, on the same wire an acceptance already
 * travels in, where every field is lowercase hex. **One wire, one alphabet.**
 */
export interface InboxKeypair {
  /** Published. Lowercase hex, 64 characters. */
  readonly publicKey: string;
  readonly secretKey: Uint8Array;
}

export function inboxKeypair(identity: Identity, index = INBOX_INDEX): InboxKeypair {
  const secretKey = identity.authority(Purposes.Inbox, index);
  return Object.freeze({
    publicKey: bytesToHex(x25519.getPublicKey(secretKey)),
    secretKey,
  });
}

/** What a person publishes so a company can write to them. */
export const inboxKeyOf = (identity: Identity, index = INBOX_INDEX): string =>
  inboxKeypair(identity, index).publicKey;

const HEX_32 = /^[0-9a-f]{64}$/u;
const HEX_12 = /^[0-9a-f]{24}$/u;
const HEX_BODY = /^[0-9a-f]{2,}$/u;
const MAX_NOTICE_TEXT = 300;

const isText = (value: unknown, max = MAX_NOTICE_TEXT): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/**
 * THE ONE PLACE AN ITEM BECOMES WORDS.
 *
 * **IT THROWS AND IT NEVER RETURNS A HALF-READ NOTICE.** Three codes, and they
 * are three different facts about one item: the envelope is not one
 * (`not-a-sealed-item`), the envelope is one and this wallet cannot open it
 * (`will-not-open`), the envelope opened and what came out is not a notice
 * (`not-a-notice`). The same lesson at the level of a single item — *could not
 * read* and *nothing there* are different facts and must not be merged, and so
 * are *could not read* and *read it and it was rubbish*.
 */
export function openFromInbox(item: SealedItem, keys: InboxKeypair): Notice {
  /* ANNOTATED `(why: string) => never` DELIBERATELY. TypeScript narrows on a
   * call to a never-returning function only when the const carries an explicit
   * type annotation, so dropping it here would not fail — it would quietly stop
   * narrowing `said` below and the refusals would still run. */
  const shape: (why: string) => never = (why) => {
    throw new InboxError('not-a-sealed-item', `that is not an item this wallet can open: ${why}`);
  };
  if (item === null || typeof item !== 'object') shape('it is not an object at all.');
  if (!HEX_32.test(item.ephemeral)) {
    shape('its `ephemeral` is not 32 bytes written as 64 lowercase hex characters.');
  }
  if (!HEX_12.test(item.iv)) {
    shape('its `iv` is not 12 bytes written as 24 lowercase hex characters.');
  }
  if (!HEX_BODY.test(item.body) || item.body.length % 2 !== 0) {
    shape('its `body` is not an even number of lowercase hex characters.');
  }
  /*
   * **THE TAG IS NAMED RATHER THAN IGNORED.** The reader on the other side of
   * `sealToInbox` never reads this field and neither does this; a sender that
   * filled it has put the authentication tag somewhere the body already has it,
   * and the body will then fail to authenticate. Saying which field is wrong
   * costs one line and saves a person the sentence *could not open*, which
   * names nothing they or anybody else could act on.
   */
  if (item.tag !== '') {
    shape('its `tag` is not empty. The authentication tag belongs inside `body` — '
      + 'it is the last sixteen bytes of what AES-GCM returns — and an item that '
      + 'carries it here has it in two places.');
  }

  let plaintext: string;
  try {
    const shared = x25519.getSharedSecret(keys.secretKey, hexToBytes(item.ephemeral));
    const key = sha256(shared);
    plaintext = new TextDecoder().decode(
      gcm(key, hexToBytes(item.iv)).decrypt(hexToBytes(item.body)));
  } catch (e) {
    throw new InboxError(
      'will-not-open',
      'this wallet cannot open that item. It is sealed to a key this wallet does not '
      + `hold, or it was altered after it was sealed: ${(e as Error).message}`);
  }

  let body: unknown;
  try { body = JSON.parse(plaintext); } catch (e) {
    throw new InboxError(
      'not-a-notice',
      `that item opened and what came out is not JSON: ${(e as Error).message}`);
  }
  const said = body as Record<string, unknown> | null;
  const wrong: (why: string) => never = (why) => {
    throw new InboxError('not-a-notice', `that item opened and ${why}`);
  };
  if (said === null || typeof said !== 'object') wrong('what came out is not an object.');
  if (said.schema !== NOTICE_SCHEMA) {
    wrong(`it is not a notice: its \`schema\` is ${JSON.stringify(said.schema)} and this `
      + `wallet reads ${JSON.stringify(NOTICE_SCHEMA)}.`);
  }
  const kind = (NOTICE_KINDS as readonly string[]).find((k) => k === said.kind);
  if (kind === undefined) {
    wrong(`its \`kind\` is ${JSON.stringify(said.kind)}, which this wallet has no words `
      + `for. It reads ${NOTICE_KINDS.map((k) => `'${k}'`).join(', ')}.`);
  }
  if (typeof said.at !== 'number' || !Number.isFinite(said.at)) {
    wrong('its `at` is not a number of milliseconds.');
  }
  const from = said.from as Record<string, unknown> | undefined;
  if (from === undefined || typeof from !== 'object' || from === null
    || !isText(from.name) || !isText(from.rdns)) {
    wrong('its `from` does not carry a `name` and an `rdns` this wallet can show.');
  }
  if (!isText(said.where)) wrong('its `where` is not a place written down.');
  if (!isOrigin(said.where as string)) {
    wrong(`its \`where\` is ${JSON.stringify(said.where)}, which is not an \`https:\` origin. `
      + 'This wallet shows a place a person can go to and check; a path, a query or a '
      + 'scheme that is not https is not one.');
  }
  if (said.says !== undefined && !isText(said.says)) {
    wrong('its `says` is present and is not one line of text.');
  }
  return Object.freeze({
    schema: NOTICE_SCHEMA,
    kind: kind as NoticeKind,
    at: said.at as number,
    from: Object.freeze({ name: (from as { name: string }).name, rdns: (from as { rdns: string }).rdns }),
    where: said.where as string,
    ...(said.says === undefined ? {} : { says: said.says as string }),
  });
}

/**
 * AN ORIGIN AND NOTHING ELSE. `https:`, a host, an optional port, and no path,
 * query or fragment — `new URL('https://a.example/x').origin` silently answers
 * `https://a.example`, so comparing the round trip is what refuses the path
 * rather than accepting it and quietly dropping it. A dropped path is a
 * different place from the one the sender wrote.
 */
function isOrigin(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && url.origin === value;
}

/**
 * ONE RESULT PER ITEM, ALWAYS. **THIS IS THAT LESSON MADE STRUCTURAL.**
 *
 * *"could not read and nothing there are different facts and must not be
 * merged."* A function that returned `Notice[]` would have exactly one way to
 * express an item it could not open — leaving it out — and a person with one
 * item nobody can open would be shown an empty inbox. **There is no arm of
 * `openAll` that drops an item**, and the type is what says so: the array it
 * returns is the same length as the array it was given, and a test asserts that
 * rather than trusting it.
 */
export type Opening =
  | { readonly of: 'notice'; readonly id: string; readonly notice: Notice }
  | {
    readonly of: 'unopenable';
    readonly id: string;
    readonly code: InboxFailure;
    readonly why: string;
  };

export function openAll(
  items: readonly SealedItem[], keys: InboxKeypair,
): readonly Opening[] {
  return items.map((item) => {
    /* The host chose `id`, so it may be anything at all, including absent. A
     * reference nobody can quote is worse than a made-up one only if it is
     * presented as the host's; this says which it is. */
    const id = typeof item?.id === 'string' && item.id.length > 0 && item.id.length <= 200
      ? item.id : '(the host gave this item no reference)';
    try {
      return { of: 'notice', id, notice: openFromInbox(item, keys) } as const;
    } catch (e) {
      const error = e as InboxError;
      return {
        of: 'unopenable',
        id,
        code: error.code ?? 'not-a-sealed-item',
        why: error.message,
      } as const;
    }
  });
}

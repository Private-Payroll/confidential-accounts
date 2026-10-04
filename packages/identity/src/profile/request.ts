import type { AttributeName } from './definition.js';
import { usableOrigin, whyNotUsable } from './origin.js';
import { RECEIVING_ADDRESS } from './attributes.js';
import type { Registry } from './attributes.js';
import { readAccountAddress, readCompanyLabel, readVaultAddress } from './company-label.js';
import type { AccountAddress, CompanyLabel, VaultAddress } from './company-label.js';

/**
 * WHAT AN APPLICATION SENDS, AND THE ONE FIELD IT MAY NEVER SEND.
 *
 * **THE ORIGIN IS OBSERVED, NOT CLAIMED — AND THE STRONGEST FORM OF THAT RULE
 * IS THAT THE TYPE HAS NO PLACE TO PUT ONE.** The design this was built from
 * sketched the request with
 * `requester: { name, rdns, origin }` and a note beside it saying the origin
 * is taken from the browser. **A note is not a defence.** This is the case
 * where two of pairing's three stated defences turned out to be sentences in a
 * comment, and both mutations lived.
 *
 * So `DisclosureRequest` — the parsed value the rest of this wallet works with
 * — carries an origin the PARSER put there from an argument, and the wire shape
 * has no `origin` key at all. A payload that carries one is **REFUSED BY NAME**
 * rather than ignored: a requester that sends an origin either misunderstands
 * the protocol or is attacking it, and silently dropping the field leaves the
 * honest one believing it was honoured. The same family — a name standing in for
 * an identity.
 *
 * ── A REQUESTER ASKS FOR *AN* ADDRESS AND NEVER PROPOSES ONE ─────────
 *
 * The first attribute this wallet DERIVES rather than
 * stores is a receiving address, and it is the first thing in this protocol
 * that money follows. **So the rule the origin has always had now has to cover
 * a second field: a request may say WHAT it wants and never WHICH VALUE it
 * expects back.**
 *
 * A request that carried an address would be a payer telling a payee where they
 * are paid, and a screen that showed it would be asking a person to confirm
 * somebody else's arithmetic about their own keys. It is refused **by presence
 * and by name** in two places — on the request itself and on any one `want` —
 * for the reason the origin is: ignoring the field would leave whoever sent it
 * entitled to believe the wallet had read it, and here believing that is
 * believing they chose where the money goes.
 *
 * **AND A WANT CARRIES EXACTLY THREE FIELDS.** Not *no address*; not *no known
 * bad key*. Anything beyond `attribute`, `required` and `reason` is refused,
 * because a list of forbidden names is a list somebody adds to after the fact
 * and this protocol has one version. `wantsOf` is where that lives.
 *
 * **AND THE REQUESTER CANNOT DEFINE AN ATTRIBUTE.** §3.4, §6. `wants` names
 * attributes from OUR vocabulary; a name this registry does not know is
 * reported as unknown and shown to the person as unknown. It never becomes an
 * attribute, and no rule, label or validation arrives from outside.
 *
 * ── AN ASK HAS A KIND, AND SIGNING IN IS ONE OF THEM ──────────────────
 *
 * The protocol has three action kinds — `disclose`, `sign-in`, `approve`. Two
 * are here; `approve` comes later.
 *
 * **A SIGN-IN IS NOT A DISCLOSURE WITH AN EMPTY LIST.** The first draft of that
 * design said it was, and corrected itself the same day by checking: `nothing-asked-
 * for` below refuses a request whose `wants` is empty, and **that guard is
 * right and stays** — a disclosure asking for nothing is a bug in the
 * requester. So a sign-in is its own kind: it asks for no attributes and
 * **carries none, by refusal rather than by being ignored.** Ignoring a field
 * is how a requester comes to believe it was honoured, which is the same
 * sentence the `origin` rule above is written in.
 *
 * **WHAT DOES NOT CHANGE IS THE PAYLOAD.** `payload.ts` is untouched by this
 * change: a sign-in is a `DisclosurePayload` with `disclosed` and `declined`
 * empty, so the same bytes, the same signature and the same `verify` serve both
 * kinds. `sign-in.test.ts` says that out loud.
 *
 * **AN ABSENT `kind` IS A DISCLOSURE, AND THAT IS NOT A DEFAULT STANDING IN FOR
 * A MECHANISM.** Two reasons, and the second is the one that matters:
 *
 *   1. `REQUEST_SCHEMA` is versioned and shipped with exactly ONE kind in it.
 *      Every request that has ever existed under `…/v1` is a disclosure, so
 *      absence has one meaning and not two — which is the whole of this file's
 *      test for whether a missing value is honest.
 *   2. **ABSENCE FAILS CLOSED, IN BOTH DIRECTIONS, AND BOTH ARE PINNED.** It
 *      lands on the kind that demands MORE: a disclosure must name at least one
 *      attribute, so an omitted field can never produce the attribute-free ask.
 *      Strip `kind: 'sign-in'` off a sign-in in flight and it becomes a
 *      disclosure asking for nothing — refused. Add `kind: 'sign-in'` to a
 *      disclosure that carries `wants` — refused. **Neither edit of this field
 *      yields something the person is asked to approve.**
 *
 * That is the opposite of a wallet reading an OMITTED field as
 * permission to do the weaker thing. Here the omission is the stricter path.
 *
 * **AN UNKNOWN KIND IS REFUSED BY NAME.** `approve` — §4's third — is not built,
 * and a wallet that quietly treated it as one of these two would approve the
 * wrong thing while showing the right screen.
 *
 * -- A THIRD KIND, AND IT IS NOT A THIRD VARIATION OF THE OTHER TWO ---------
 *
 * A sign-in tells a requester WHO this
 * is. A disclosure tells it A FACT. **An unlock gives it something that keeps
 * working** -- the key that opens the records that requester holds for this
 * person. A disclosure is a statement about the past; **a key is a capability
 * for the future**: it cannot be taken back, it does not expire on its own, and
 * nobody can watch it being used.
 *
 * **NOTHING ABOUT THIS FILE'S ORIGIN RULE CHANGES, AND HERE IT IS THE WHOLE
 * SECURITY OF THE THING.** For a disclosure, an origin read out of the payload
 * would hand a requester facts meant for somebody else. For an unlock it would
 * let a requester ASK FOR ANOTHER COMPANY'S KEY BY NAME -- the released key is
 * a pure function of the origin (`unlock.ts`), so an origin field would BE the
 * request. The refusal above already covers it, by there being nowhere in the
 * type to put one; `unlock.test.ts` asserts it for this kind specifically
 * rather than inheriting the claim from the kind next door.
 *
 * **AN UNLOCK CARRIES NO `wants` EITHER, AND BY PRESENCE RATHER THAN CONTENT.**
 * It asks for no attributes and it is not a disclosure with a key bolted on.
 * The code is its own -- `attributes-on-an-unlock` -- because a refusal that
 * named the wrong kind would be this module telling a requester something
 * untrue about its own message.
 *
 * **AND AN ABSENT `kind` IS STILL A DISCLOSURE.** Stripping `kind: 'unlock'`
 * off an unlock in flight leaves a disclosure that asks for nothing, which is
 * refused. The third kind lands on the same fail-closed edge as the second.
 *
 * -- AN UNLOCK NAMES A COMPANY, AND THAT IS THE ONE CLAIMED VALUE -----------
 *
 * **The key an unlock asks for
 * is no longer derived from the origin; it is derived from the COMPANY'S
 * LABEL** (`company-label.ts`), because a hostname is a deployment detail and
 * anything sealed under one can only ever be opened at it.
 *
 * **SO AN UNLOCK CARRIES ONE FIELD THAT SELECTS A KEY, AND THIS FILE'S OLDEST
 * RULE IS THAT NOTHING MAY.** That is not an oversight and it is not a
 * loosening of the origin rule -- the origin is still observed, still never
 * read from the message, and still decides who gets answered. It is a cost
 * accepted knowingly on 23 Aug: **a product that cannot be left is a certainty,
 * and a phished key is only dangerous to somebody who has ALSO obtained the
 * sealed data.** What is owed in return is that a person can SEE the mismatch,
 * and that debt is paid on the screen rather than here.
 *
 * **WHAT THIS FILE OWES IS THE SHAPE.** A company is named by its label --
 * `co_` and sixty-four lower-case hex characters -- and anything else, a
 * contract address included, is refused BY NAME. **A malformed identifier is a
 * request that does not know what it is asking for.** The account that carries
 * the label is named beside it, by its contract address, in a field of its
 * own; the wallet reads the label off that account itself before it gives or
 * signs anything.
 *
 * **AND THE OTHER TWO KINDS REFUSE THE FIELD.** A disclosure and a sign-in do
 * not open records and have no company to name, so one that carries the field
 * is refused rather than half-honoured -- the same sentence `origin` and
 * `wants` are already refused in, and each with its own code so that a refusal
 * never tells a requester something untrue about its own message.
 */

export const REQUEST_SCHEMA = 'midnight-identity/disclosure-request/v1';

/**
 * **THE ONE MESSAGE A WALLET SENDS WHILE IT WORKS**, named here so that an
 * asker can say it knows it: an ask carrying `progress` set to exactly this
 * string is told what the wallet is doing while it works. An ask without it,
 * or with any other value, is told nothing until the answer - which is all a
 * page that does not know this message can safely hear.
 */
export const PROGRESS_SCHEMA = 'midnight-identity/wallet-progress/v1';

/**
 * THE KINDS THIS WALLET ANSWERS.
 *
 * `approve` is deliberately absent: it is the proposal signature, it needs a
 * key that does not exist yet, and **a name in this array is a promise that the
 * screen behind it exists.** One change adds `unlock`, and the screen with it. Another adds
 * `join`, and it is the same promise: `screens/approve.tsx` renders it in the
 * frame the disclosure already had, not in a second one.
 *
 * **THE ORDER IS THE ORDER THIS ARRAY IS READ OUT IN**, by `namedKinds` below,
 * onto a screen a person is standing in front of. `join` is appended rather
 * than inserted, so the sentence a refusal already produced does not change
 * shape for the three kinds that were there before it.
 */
export const ASK_KINDS = ['disclosure', 'sign-in', 'unlock', 'join', 'keyring', 'balance', 'committee', 'records-key', 'holders', 'creation'] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** One thing an application is asking for. */
export interface Want {
  readonly attribute: AttributeName;
  readonly required: boolean;
  /** One sentence, the requester's own words. Rendered as text, never as markup. */
  readonly reason?: string;
}

/** What every kind of ask carries, whatever it is asking for. */
export interface Asking {
  readonly schema: typeof REQUEST_SCHEMA;
  readonly requester: {
    /** OBSERVED. Put here by the parser from its own argument. */
    readonly origin: string;
    /** The requester's own words about itself. Untrusted; shown as text. */
    readonly name: string;
    readonly rdns: string;
  };
  /** One sentence the person reads. The requester's words. */
  readonly purpose: string;
  readonly nonce: string;
  readonly expiresAt: number;
  /**
   * The asker said it knows `PROGRESS_SCHEMA`. Present only when it did, and
   * it widens nothing: what it opens is a stage name while the wallet works.
   */
  readonly hearsProgress?: true;
}

/** The request, AFTER parsing — `origin` is the browser's, not the payload's. */
export interface DisclosureRequest extends Asking {
  readonly kind: 'disclosure';
  /** Never empty. `nothing-asked-for` is what an empty one becomes. */
  readonly wants: readonly Want[];
}

/**
 * SIGNING IN — one question, and no attributes.
 *
 * **THERE IS NO `wants` ON THIS TYPE, NOT AN EMPTY ONE.** The same shape as the
 * absent `origin` above, for the same reason: a field that is sometimes read is
 * a field that can be made to be read, and a field that is never there cannot.
 */
export interface SignInRequest extends Asking {
  readonly kind: 'sign-in';
}

/**
 * ASKING FOR THE KEY THAT OPENS WHAT THIS SITE HOLDS FOR YOU.
 *
 * **`company` IS THE ONE FIELD IN THIS PROTOCOL THAT A REQUESTER CHOOSES AND
 * THAT REACHES A KEY**, and it was put there deliberately.
 * `origin` is still absent from the wire and still supplied by the parser from
 * the browser; what changed is that the origin no longer selects the key, so
 * something durable had to: the company's label, which its founding signer's
 * wallet drew and its account carries on the chain.
 *
 * **THE LABEL IS NEVER SHORTENED ANYWHERE IN THIS PROTOCOL.** A selector
 * narrower than the thing it selects can be ground -- two origins were ground onto
 * one 31-bit index in 2.86 billion tries -- so it travels whole, is checked
 * whole, is derived from whole, and is shown to the person whole.
 */
export interface UnlockRequest extends Asking {
  readonly kind: 'unlock';
  /** The company's label. CLAIMED, checked for shape, and shown on the screen. */
  readonly company: CompanyLabel;
  /**
   * The account that carries the label, or null for a company that has no
   * account yet. CLAIMED: the wallet reads the label off this account itself
   * before it gives anything, and never derives from it.
   */
  readonly account: AccountAddress | null;
}

/**
 * ACCEPTING AN INVITATION.
 *
 * **A JOIN IS A DISCLOSURE WHOSE ANSWER IS SEALED TO SOMEBODY WHO IS NOT ON
 * THE OTHER END OF THIS CHANNEL, AND THAT IS THE ONLY THING THAT MAKES IT ITS
 * OWN KIND.** Everything a person is asked for arrives as `wants`, in the same
 * shape a disclosure uses, and is approved item by item on the same screen; the
 * scope's *"an address and probably a name"* is the COMPANY'S sentence and not
 * a list this wallet fixes for it. **A kind that fixed the list would be this
 * wallet deciding what an employer needs to know**, which it cannot know.
 *
 * **THE ONE THING IT DOES FIX IS THAT AN INVITATION ASKS WHERE TO PAY.** §6.
 * Not WHICH attributes -- the company chooses those -- but that a message
 * calling itself a join asks for `receiving-address`, required. An acceptance
 * with nowhere to pay anybody is meaningless, and refusing it is refusing a
 * message that is not what it says it is, which is the same thing the inbox key
 * and `company-on-a-join` refuse. `parseAsk` carries the argument in full.
 *
 * What it also fixes is where the answer can be read. §5: *"AND THE ADDRESS NEVER
 * REACHES US EITHER -- decided 22 Aug. The acceptance seals it to the company's
 * inbox key on the employee's own device."* So a join carries the key the
 * acceptance is sealed to, and a disclosure -- which answers in the clear over
 * the channel -- must not carry one, by presence and with its own code.
 *
 * **THE KEY IS CLAIMED, LIKE `company` ON AN UNLOCK, AND THE COST IS THE SAME
 * ONE ACCEPTED KNOWINGLY.** Nothing in this wallet can tell whether the key
 * in the ask belongs to the company named on the page. What it can tell is
 * whether the request knows what it is asking for -- the shape -- and the
 * screen says out loud that the rest is unchecked. **A key that is somebody
 * else's is an address disclosed to somebody else**, which is why the screen
 * shows it whole rather than leaving it in the protocol.
 */
export interface JoinRequest extends Asking {
  readonly kind: 'join';
  /** Never empty. `nothing-asked-for` is what an empty one becomes -- the same
   * guard the disclosure has, and right here for the same reason: an invitation
   * that asks for nothing is a bug in the inviter, not an acceptance. */
  readonly wants: readonly Want[];
  /**
   * The company's inbox public key -- an X25519 public key, **sixty-four
   * lowercase hex characters**, arriving in any spelling and folded here
   * (the hex argument, which is about hex and not about this field).
   *
   * **THE ENCODING IS NOT THIS REPOSITORY'S TO CHOOSE AND IT IS NOT THIS
   * REPOSITORY'S CONVENTION.** `recovery/locks.ts` publishes X25519 public keys
   * as base64url, so base64url is the instinct here and it is wrong: the code
   * that consumes an acceptance lives in the other repository, reads the field
   * as `inboxPublicKey` and decodes it with `fromHex`. **Where two repositories
   * disagree about an encoding, the wire follows the reader.** `profile/inbox.ts`
   * carries the whole wire contract, including the answer's shape.
   */
  readonly inboxPublicKey: string;
}

/**
 * ASKING FOR THE KEY A PERSON'S OWN SAVED KEYS ARE SEALED UNDER AT THIS SITE.
 *
 * **A PERSON HAS ONE SET OF SAVED KEYS AT A SITE AND MAY BELONG TO MANY
 * COMPANIES THERE**, so that set cannot be sealed under any one company's key:
 * a second company's secrets could never be saved beside the first's. This asks
 * for the key that set IS sealed under, which belongs to the person.
 *
 * **`person` IS CLAIMED AND REACHES THE KEY.** It is the identifier the site
 * gave the person who signed in, and it is the only thing that separates one
 * site's keys from another's for the same wallet. The origin still does not
 * select the key, for the reason `unlock` gives: a hostname is a deployment
 * detail, and keys sealed under one could only ever be opened at one address.
 *
 * **`signedInAs` IS CLAIMED AND NEVER REACHES THE KEY. IT GATES.** It is the
 * wallet address the page says it signed in as. A wallet holding no account
 * with exactly that address does not give the key at all -- so, in a browser
 * holding several wallets, the key cannot come from one other than the wallet
 * the person signed in with. Absent means the page does not know which address
 * it signed in as, and the screen says so.
 *
 * **`company` IS OPTIONAL, AND WHEN IT IS PRESENT THE ANSWER CARRIES THAT
 * COMPANY'S KEY TOO**, derived exactly as an `unlock` derives it. The page asks
 * for both together when it needs a company's key and wants to know that it
 * came from the same wallet whose keyring key it already holds: two keys in one
 * answer are two keys from one wallet.
 */
export interface KeyringRequest extends Asking {
  readonly kind: 'keyring';
  /** The site's own identifier for the signed-in person. Checked for shape, used whole. */
  readonly person: string;
  /** The address the page signed in as, or null when it does not know. Never an ingredient. */
  readonly signedInAs: string | null;
  /** The label of a company whose key is wanted in the same answer, or null. */
  readonly company: CompanyLabel | null;
  /** The account that carries that label, or null for none or none yet. Claimed; read off the chain. */
  readonly account: AccountAddress | null;
  /**
   * **TRUE WHEN THE PAGE IS STARTING A COMPANY**: the wallet draws the new
   * company's label itself and answers with it and its keys. Never together
   * with `company` or `account`.
   */
  readonly drawLabel: boolean;
}

/**
 * ASKING THIS WALLET TO PAY FOR THE COIN LEGS OF A TRANSACTION A PAGE BUILT.
 *
 * **THE ONE KIND THAT MOVES MONEY OUT OF THIS WALLET.** A company's page builds
 * and proves a call into the company's vault - a deposit - and the call needs
 * coins the page does not hold. This asks the wallet to add them from the
 * person's own balance, sign what it added, and hand the finished transaction
 * back. The wallet balances the shielded and unshielded legs and nothing else:
 * the network fee is the company's fee payer's, and a wallet asked here never
 * spends DUST.
 *
 * **EVERYTHING HERE IS CLAIMED.** `company` and `vault` are the page's words
 * and are shown whole. `transaction` is bytes the wallet reads for itself: what
 * leaves the wallet is worked out from the transaction, never from a figure the
 * page supplies, and there is no field on this type for one.
 */
export interface BalanceRequest extends Asking {
  readonly kind: 'balance';
  /** The company's label. Claimed; shown. */
  readonly company: CompanyLabel;
  /** The account that carries the label. Claimed; read off the chain before anything is paid. */
  readonly account: AccountAddress;
  /** The contract the transaction calls, canonical lower case. Claimed; checked against the transaction. */
  readonly vault: VaultAddress;
  /** Base64 of a proven transaction that is not yet bound. */
  readonly transaction: string;
}

/** A committee key as it travels on this wire: the tag the ledger names, and thirty-two bytes of lower-case hex. */
export interface CommitteeKeyOnTheWire {
  readonly tag: 'schnorr';
  readonly value: string;
}

/** A committee: its keys in the order the chain holds them, and how many of them must sign a change. */
export interface CommitteeOnTheWire {
  readonly committee: readonly CommitteeKeyOnTheWire[];
  readonly threshold: number;
}

/** One contract whose committee the ask changes. */
export interface CommitteeChangeOfAContract {
  readonly contract: 'account' | 'vault';
  /** The contract's address, canonical lower case. Claimed; shown whole. */
  readonly address: AccountAddress | VaultAddress;
  /** The counter the chain holds for the contract's rules now, in decimal. Claimed; signed over. */
  readonly counter: string;
  /** The committee that holds the contract now, which is the one that signs. Claimed; shown. */
  readonly now: CommitteeOnTheWire;
}

/**
 * ASKING THIS WALLET TO SIGN A CHANGE TO WHO HOLDS A COMPANY'S RULES.
 *
 * **THE ONE KIND THAT SIGNS WITH A COMMITTEE KEY.** Every contract a company
 * has - its account and each vault - carries a list of keys and a threshold
 * that decide who may change the contract's rules, and this wallet holds one of
 * those keys for each company its person signs for. When a signer joins or
 * leaves, or the threshold changes, each contract's list must be replaced, and
 * the replacement must be signed by enough of the keys on the list now.
 *
 * **THE WALLET BUILDS WHAT IT SIGNS.** Nothing in this ask is bytes to sign.
 * It names, for each contract, the address, the counter and the committee that
 * holds it now, and once, the committee to install. The wallet makes the one
 * change that replaces the whole list with that committee and signs that, so
 * what it signs can only be what the screen showed: who joins, who leaves and
 * the new threshold. There is no field on this type for anything else a change
 * to a contract's rules could do.
 *
 * **EVERYTHING HERE IS CLAIMED.** A page could name a committee that is not the
 * company's, or say a contract is held by keys it is not held by. The first is
 * shown whole and is exactly what would be installed; the second only changes
 * who the screen says leaves, because the chain checks the signature against
 * the committee that really holds the contract.
 */
export interface CommitteeRequest extends Asking {
  readonly kind: 'committee';
  /** The company's label. It selects the key that signs. */
  readonly company: CompanyLabel;
  /**
   * The account that carries the label. Claimed; read off the chain before
   * anything is signed, and equal to the address of any `account` contract
   * the ask names.
   */
  readonly account: AccountAddress;
  /** The committee to install, the same on every contract. */
  readonly to: CommitteeOnTheWire;
  /** Never empty, and no address twice. */
  readonly contracts: readonly CommitteeChangeOfAContract[];
}

/**
 * ASKING THIS WALLET TO SIGN ONE SIGNER'S RECORDS KEY FOR THEIR SEAT ON A
 * COMPANY'S ACCOUNT, AND TO SAY WHO HOLDS THAT ACCOUNT NOW.
 *
 * A vault's secret is sealed to each signer's records key, and every signer's
 * device checks each of those keys before it approves the secret. What it
 * checks is a statement this ask produces: the person's records key for the
 * company, and the seat they hold on its account, signed with the committee
 * key this wallet keeps for that company. The answer also carries who holds the
 * account as this wallet read it from the chain itself: the committee, its
 * threshold and every seat the account holds now.
 *
 * **THE SEAT IS THE PAGE'S WORD AND IS CHECKED, NOT TRUSTED.** It is worked
 * out from key material the page holds and this wallet does not. The wallet
 * signs it only when the account, read off the chain by this wallet, seats it
 * now; a seat the account no longer holds is refused.
 */
export interface RecordsKeyRequest extends Asking {
  readonly kind: 'records-key';
  /** The company's label. It selects the keys. */
  readonly company: CompanyLabel;
  /** The account that carries the label. Claimed; read off the chain before anything is signed. */
  readonly account: AccountAddress;
  /** The seat this person holds on that account, as 64 lower-case hex characters. Claimed; read off the chain. */
  readonly seat: string;
  /**
   * One of the company's vaults, when the page is about to approve that vault's
   * secret. Claimed: the wallet reads who holds it, and which account it is
   * pinned to, off the chain itself, and hands that back beside the account's
   * seats. Absent when no vault is being approved.
   */
  readonly vault?: VaultAddress;
  /**
   * The filing key this person's filings for the company are signed with, when
   * the page also asks for their directory entry: the wallet signs the entry
   * (this key, the records key it works out, and the seat) in the same press.
   * Claimed: the wallet shows it and signs it, and cannot tell whose it is.
   */
  readonly signingKey?: string;
}

/** One circuit's verifier key, as the second step of a company's creation inserts it. Base64 of the key's file. */
export interface InsertedKeyOnTheWire {
  readonly circuit: string;
  readonly key: string;
}

/**
 * ASKING THE FOUNDING SIGNER'S WALLET TO FINISH CREATING A COMPANY'S ACCOUNT,
 * BEFORE ANYTHING IS SENT.
 *
 * A company's account is deployed in two transactions: the deploy, and one
 * update that inserts the rest of its circuits. The deploy is held from its
 * first transaction by this wallet's own committee key for the label it drew,
 * so the update can be signed by that key alone, and by nothing else. **The
 * wallet reads the unsent deploy itself** - who holds it, the label it carries,
 * its address and the circuits it runs - **and builds the update itself** from
 * the keys named here, each checked against this build's own; it signs that,
 * and pins the address as the account carrying the label.
 *
 * **EVERYTHING HERE IS CLAIMED, AND NONE OF IT IS TAKEN ON TRUST.** The address
 * must be the deploy's own; every key must be this build's.
 */
export interface CreationRequest extends Asking {
  readonly kind: 'creation';
  /** The label this wallet drew for the company. It selects the key that signs. */
  readonly company: CompanyLabel;
  /** The address of the account the deploy below creates. Claimed; worked out again from the deploy. */
  readonly account: AccountAddress;
  /** The deploy, unsent, as base64. */
  readonly deploy: string;
  /** The keys the second step inserts, one per circuit. */
  readonly insert: readonly InsertedKeyOnTheWire[];
}

/**
 * ASKING THIS WALLET WHO HOLDS A COMPANY'S ACCOUNT NOW, AS IT READS THE CHAIN
 * ITSELF, AND NOTHING ELSE.
 *
 * The answer is public chain facts only - the account's committee and its
 * threshold, the account's own approval threshold, every seat it holds and
 * every vault it has adopted; and, when the ask names one vault, that vault's
 * state at its deploy and at each update since. **Nothing private is handed
 * over and nothing is signed, so it is answered without a press.** Every
 * field but the label, the account and one vault is refused.
 */
export interface HoldersRequest extends Asking {
  readonly kind: 'holders';
  /** The company's label. Claimed; the account read must carry it. */
  readonly company: CompanyLabel;
  /** The account that carries the label. Claimed; read off the chain. */
  readonly account: AccountAddress;
}

/** What an application may open this wallet with. */
export type Ask =
  | DisclosureRequest | SignInRequest | UnlockRequest | JoinRequest | KeyringRequest | BalanceRequest | CommitteeRequest
  | RecordsKeyRequest | HoldersRequest | CreationRequest;

/**
 * THE KINDS THAT CARRY A LIST OF THINGS ASKED FOR.
 *
 * **a second kind grew `wants`, so the screen needs a name for "the ask
 * has rows" that is not the name of one kind.** Everything that renders rows
 * takes this; `parseRequest` below still narrows to the disclosure alone,
 * because a caller asking for a request for details is asking for that one.
 */
export type Wanting = DisclosureRequest | JoinRequest;

export type RequestFailure =
  | 'not-a-request'
  | 'wrong-schema'
  | 'claims-its-own-origin'
  | 'nothing-asked-for'
  | 'malformed-field'
  | 'expired'
  | 'unknown-kind'
  | 'attributes-on-a-sign-in'
  | 'not-a-disclosure'
  /* Its own code, because a refusal that named the wrong kind would be
   * this module telling a requester something untrue about its own message. */
  | 'attributes-on-an-unlock'
  /* The company an unlock names, and the two kinds that may not name one. A
   * contract address where a label is asked is refused here; a label where an
   * address is asked, with `not-an-account-address`. */
  | 'not-a-company-label'
  | 'not-an-account-address'
  | 'company-on-a-disclosure'
  | 'company-on-a-sign-in'
  /* The key an acceptance is sealed to, and the three kinds that may
   * not name one. Each has its own code, because a refusal that named the
   * wrong kind would be this module telling a requester something untrue about
   * its own message -- the same sentence the neighbours are written in. */
  | 'not-an-inbox-key'
  /* **AND THE ONE REFUSAL ABOUT CONTENT RATHER THAN SHAPE.** The
   * `not-a-…` family means *this is not the thing it claims to be*, and that is
   * exactly what this says: a message calling itself an invitation that never
   * asks where to pay anybody is asking for something else. */
  | 'not-an-invitation'
  | 'inbox-key-on-a-disclosure'
  | 'inbox-key-on-a-sign-in'
  | 'inbox-key-on-an-unlock'
  | 'company-on-a-join'
  /* A requester asks for a thing and never proposes the answer. Two
   * codes, because they are two places and a refusal that named the wrong one
   * would tell a requester something untrue about its own message. */
  | 'proposes-an-address'
  | 'a-want-proposes-a-value'
  /* The person a keyring ask names, the address it says it signed in as, and
   * the two things a keyring ask may not carry. */
  | 'not-a-person'
  | 'not-a-signed-in-address'
  | 'attributes-on-a-keyring'
  | 'inbox-key-on-a-keyring'
  /* A person or a signed-in address on any kind but a keyring ask. One code,
   * and its sentence names the kind it arrived on. */
  | 'keyring-fields-on-another-kind'
  /* A request to balance a transaction: the transaction and the vault it
   * names, the two things it may not carry, and the fields that belong to it
   * alone arriving on another kind. */
  | 'not-a-transaction'
  | 'not-a-vault-address'
  | 'attributes-on-a-balance'
  | 'inbox-key-on-a-balance'
  | 'balance-fields-on-another-kind'
  /* A request to sign a change to a company's committee: the change itself,
   * the two things it may not carry, and its own fields arriving on another
   * kind. */
  | 'not-a-committee-change'
  | 'attributes-on-a-committee-change'
  | 'inbox-key-on-a-committee-change'
  | 'committee-fields-on-another-kind'
  | 'not-a-seat'
  | 'attributes-on-a-records-key'
  | 'inbox-key-on-a-records-key'
  | 'records-key-fields-on-another-kind'
  /* A holders ask carries a label and an account, and nothing else. */
  | 'more-than-holders'
  /* A request to finish creating a company's account: the deploy and the keys it names, the two things it may not
   * carry, and its own fields arriving on another kind. */
  | 'not-a-creation'
  | 'attributes-on-a-creation'
  | 'inbox-key-on-a-creation'
  | 'creation-fields-on-another-kind';

export class RequestError extends Error {
  readonly code: RequestFailure;
  constructor(code: RequestFailure, message: string) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
  }
}

const MAX_TEXT = 300;
const MAX_WANTS = 32;

/**
 * **THE SHAPE OF A CONTRACT ADDRESS, MEASURED.** Used for the contracts a
 * committee change names, and never for a company: a company is named by its
 * label (`company-label.ts`), which carries a prefix no address has.
 *
 * `sampleContractAddress()` in `@midnightntwrk/ledger-v9` returns sixty-four
 * LOWERCASE hex characters and `encodeContractAddress` turns one into thirty-two
 * bytes. The SDK's own validator accepts `[0-9A-Fa-f]` and rejects only a `0x`
 * prefix (`@midnight-ntwrk/midnight-js-utils/dist/index.mjs:576`, `:986`,
 * `:991`), so this accepts either case and folds: hex has one lower-case
 * spelling, and two spellings of one contract must never be two contracts. A
 * `0x` prefix fails by length.
 */
const CONTRACT_ADDRESS = /^[0-9a-fA-F]{64}$/u;

/**
 * **THE SITE'S IDENTIFIER FOR A PERSON, AS A SITE MINTS ONE.** Letters, digits,
 * `_` and `-`, at most sixty-four characters. It is used whole and never folded:
 * two identifiers differing only in case are two people.
 */
const PERSON = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * **A WALLET ADDRESS IN ITS TEXT FORM**: a lower-case human-readable part, the
 * separator `1`, and the bech32 data characters. It is compared whole against
 * the addresses this wallet derives for its own accounts; the shape is only
 * what lets a malformed one be refused by name first.
 */
const SIGNED_IN_ADDRESS = /^[a-z][a-z0-9_]{0,82}1[02-9ac-hj-np-z]{6,200}$/u;

/**
 * **THE SHAPE OF AN X25519 PUBLIC KEY ON THIS WIRE.** Thirty-two bytes,
 * written as sixty-four hex characters.
 *
 * **IT IS THE SAME PATTERN AS `CONTRACT_ADDRESS` ABOVE AND THE TWO ARE NOT THE
 * SAME FIELD**, which is why this is its own constant rather than the other one
 * reused: they are thirty-two bytes each by coincidence of the curve and of the
 * chain, they are refused with different codes, and the day either changes
 * width the other must not follow it. A shared constant here would be one
 * definition standing for two facts, which is that shape at the level of a
 * regular expression.
 *
 * **AND THE CASE IS FOLDED RATHER THAN REFUSED**, for the hex reason exactly:
 * hex has one canonical form, folding it is TOTAL -- every spelling of one key
 * maps to that form and no two keys ever meet -- so folding prevents the
 * two-spellings-one-company danger as completely as refusing did, without also
 * rejecting valid input. The canonical spelling is what travels inward, so the
 * screen shows one spelling and the seal is handed one.
 */
const INBOX_PUBLIC_KEY = /^[0-9a-fA-F]{64}$/u;

/**
 * **A TRANSACTION ON THIS WIRE IS STANDARD BASE64, AND AT MOST A MEGABYTE.**
 * The limit is the one the company's own service puts on a proven transaction,
 * so nothing this wallet would balance is refused there for its size.
 */
const TRANSACTION = /^[A-Za-z0-9+/]+={0,2}$/u;
const MAX_TRANSACTION = 1_000_000;

const isText = (value: unknown, max = MAX_TEXT): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

/**
 * EVERYTHING TRUE OF EVERY KIND, in the order it was checked before.
 *
 * The order is not cosmetic. The origin is read before anything else about the
 * requester, because a person cannot be shown who is asking if nobody observed
 * who is asking — and every refusal after it can therefore say *nothing has
 * been shown to them* and mean it.
 */
function common(
  raw: unknown, observedOrigin: string, now: number,
): { readonly body: Record<string, unknown>; readonly asking: Asking } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RequestError('not-a-request', 'that is not a request this wallet understands.');
  }
  const body = raw as Record<string, unknown>;
  if (body['schema'] !== REQUEST_SCHEMA) {
    throw new RequestError(
      'wrong-schema',
      `this wallet answers '${REQUEST_SCHEMA}' and that says `
      + `'${String(body['schema'] ?? 'nothing')}'.`);
  }
  if (!usableOrigin(observedOrigin)) {
    /*
     * A person cannot be shown who is asking if nobody observed who is asking.
     *
     * **THIS WAS `startsWith('https://')` AND THAT WAS THE DEFECT.** A prefix test
     * accepts `https://a b.example` — a name with a space in it — because it
     * never looks past the first eight characters. `unlock.ts` found that in
     * earlier and built its own stricter door rather than change shared code mid
     * round; sign-in and disclosure stayed behind the loose one, which is the
     * split this closes.
     *
     * **`origin.ts` PARSES INSTEAD OF MATCHING**, and it is where the one rule
     * now lives — including the single exception, `http` on the three hosts a
     * browser calls secure without TLS, in a development build only.
     */
    throw new RequestError('malformed-field', whyNotUsable(observedOrigin));
  }

  const requester = body['requester'];
  if (typeof requester !== 'object' || requester === null || Array.isArray(requester)) {
    throw new RequestError('malformed-field', 'the request does not say who is asking.');
  }
  const who = requester as Record<string, unknown>;

  /*
   * REFUSED BY NAME, NOT IGNORED. See the header. This is the whole of that
   * lesson in one branch: a field that would stand in for an identity is not
   * quietly dropped, because dropping it lets the sender believe it counted.
   */
  if ('origin' in who) {
    throw new RequestError(
      'claims-its-own-origin',
      'this request names its own origin. A wallet takes that from the browser and never '
      + 'from the message, because anything that can name its own origin can name '
      + 'somebody else\'s. Nothing has been shown to them.');
  }
  if ('origin' in body) {
    throw new RequestError(
      'claims-its-own-origin',
      'this request names its own origin. A wallet takes that from the browser and never '
      + 'from the message. Nothing has been shown to them.');
  }

  if (!isText(who['name'], 120)) {
    throw new RequestError('malformed-field', 'the request does not say who is asking.');
  }
  if (!isText(who['rdns'], 120)) {
    throw new RequestError('malformed-field', 'the request carries no stable identifier.');
  }
  if (!isText(body['purpose'])) {
    throw new RequestError(
      'malformed-field', 'the request does not say what it wants the details for.');
  }
  if (!isText(body['nonce'], 200)) {
    throw new RequestError('malformed-field', 'the request carries no nonce.');
  }
  const expiresAt = body['expiresAt'];
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) {
    throw new RequestError('malformed-field', 'the request carries no deadline.');
  }
  if (now >= expiresAt) {
    throw new RequestError(
      'expired', 'this request has expired. Ask the application to send a new one.');
  }

  return {
    body,
    asking: {
      schema: REQUEST_SCHEMA,
      requester: Object.freeze({
        origin: observedOrigin,
        name: who['name'],
        rdns: who['rdns'],
      }),
      purpose: body['purpose'],
      nonce: body['nonce'],
      expiresAt,
      ...(body['progress'] === PROGRESS_SCHEMA ? { hearsProgress: true as const } : {}),
    },
  };
}

/**
 * THE KINDS, SPELLED FOR A PERSON TO READ.
 *
 * It was `join(' and ')`, written when there were two. With three that
 * produced *'disclosure' and 'sign-in' and 'unlock'* on a screen a person is
 * standing in front of. Nothing a test asserts on changes -- every assertion in
 * `sign-in.test.ts` on this message is a `toContain` of one kind's name.
 *
 * **A FOURTH KIND CHANGES NOTHING HERE, WHICH IS A CLAIM AND NOT AN
 * ASSUMPTION.** The comma-and-final-`and` form was written to be right for any
 * count, and the count is the array's length rather than a literal, so the
 * sentence became *'disclosure', 'sign-in', 'unlock' and 'join'* with no edit.
 * **A property nobody checks is a property that stops being true**, so
 * `join.test.ts` asserts the whole sentence verbatim rather than a `toContain`
 * of the new name -- the one assertion in this repository that would go red if
 * a fifth kind were appended and this function were not read again.
 */
const namedKinds = (): string => {
  const quoted = ASK_KINDS.map((k) => `'${k}'`);
  const last = quoted[quoted.length - 1] as string;
  return quoted.length === 1 ? last : `${quoted.slice(0, -1).join(', ')} and ${last}`;
};

/** Absent is a disclosure — the header says why, and why that is not a default. */
function kindOf(body: Record<string, unknown>): AskKind {
  const kind = body['kind'];
  if (kind === undefined) return 'disclosure';
  const known = (ASK_KINDS as readonly string[]).find((k) => k === kind);
  if (known !== undefined) return known as AskKind;
  throw new RequestError(
    'unknown-kind',
    `this wallet answers ${namedKinds()}, and that asks `
    + `for '${String(kind)}'. It is refused rather than treated as one of them, because a `
    + 'wallet guessing which kind of thing it is approving is a wallet approving the wrong '
    + 'thing behind the right screen. Nothing has been shown to them.');
}

/** The `wants` of a disclosure. Never empty — that is `nothing-asked-for`. */
function wantsOf(body: Record<string, unknown>): readonly Want[] {
  const wants = body['wants'];
  if (!Array.isArray(wants) || wants.length === 0) {
    throw new RequestError('nothing-asked-for', 'the request asks for nothing.');
  }
  if (wants.length > MAX_WANTS) {
    throw new RequestError(
      'malformed-field', `a request asks for at most ${MAX_WANTS} things.`);
  }
  const parsed: Want[] = [];
  const seen = new Set<string>();
  for (const want of wants as unknown[]) {
    if (typeof want !== 'object' || want === null) {
      throw new RequestError('malformed-field', 'one of the things asked for is not readable.');
    }
    const w = want as Record<string, unknown>;
    if (!isText(w['attribute'], 120)) {
      throw new RequestError('malformed-field', 'one of the things asked for has no name.');
    }
    if (typeof w['required'] !== 'boolean') {
      throw new RequestError(
        'malformed-field',
        `'${String(w['attribute'])}' does not say whether it is required. Required and `
        + 'optional are shown differently and the difference is not the wallet\'s to guess.');
    }
    const attribute = w['attribute'] as AttributeName;
    /*
     * **THREE FIELDS, AND ANYTHING ELSE IS REFUSED BY NAME.**
     *
     * The field this is written against is an ADDRESS: a want carrying one
     * would be a payer naming where a payee is paid, and this wallet derives
     * that from the person's own keys and from the slot they choose. **The
     * check is not a list of forbidden names**, because a list is a thing
     * somebody extends after the fact and the field after `address` would not
     * be on it. It is the whole shape, stated once.
     */
    for (const key of Object.keys(w)) {
      if (key === 'attribute' || key === 'required' || key === 'reason') continue;
      throw new RequestError(
        'a-want-proposes-a-value',
        `'${attribute}' is asked for with a '${key}' beside it. A request says what it wants `
        + 'and never what the answer is: a receiving address is worked out from this '
        + 'person\'s own keys and from the wallet they choose, so a value arriving with the '
        + 'question could only be somebody else\'s idea of where their money goes. It is '
        + 'refused rather than ignored. Nothing has been shown to them.');
    }
    if (seen.has(attribute)) {
      throw new RequestError('malformed-field', `'${attribute}' is asked for twice.`);
    }
    seen.add(attribute);
    const reason = w['reason'];
    parsed.push(Object.freeze({
      attribute,
      required: w['required'],
      ...(isText(reason) ? { reason } : {}),
    }));
  }
  return Object.freeze(parsed);
}

/** The most contracts one committee change is signed for in one press. */
const MAX_CONTRACTS = 64;
/** The most keys a committee on this wire may list. */
const MAX_COMMITTEE = 64;
const COMMITTEE_KEY = /^[0-9a-fA-F]{64}$/u;
const COUNTER = /^[0-9]{1,20}$/u;

/*
 * **A COMPANY IS NAMED BY ITS LABEL AND ITS ACCOUNT BY AN ADDRESS, AND EACH
 * READER REFUSES THE OTHER.** One sentence each, so every kind says the same
 * thing about the same mistake. `asks` opens the sentence in the kind's own
 * words, and `nothing` closes it with what was not done.
 */
const labelIn = (value: unknown, asks: string, nothing: string): CompanyLabel => {
  const label = readCompanyLabel(value);
  if (label === null) {
    throw new RequestError(
      'not-a-company-label',
      `${asks} and does not name a company this wallet can make sense of. A company is named by `
      + 'its label - co_ and sixty-four lower-case characters - and an account\'s address is not '
      + `one. ${nothing}`);
  }
  return label;
};

const accountIn = (value: unknown, asks: string, nothing: string): AccountAddress => {
  const account = readAccountAddress(value);
  if (account === null) {
    throw new RequestError(
      'not-an-account-address',
      `${asks} and does not name the company's account by an address this wallet can make sense of. `
      + 'An account is named by its sixty-four character address on the chain, and a company\'s label '
      + `is not one. ${nothing}`);
  }
  return account;
};

/** An account that may be absent: `null` when it is, the address when it reads as one, refused otherwise. */
const accountMaybeIn = (value: unknown, asks: string, nothing: string): AccountAddress | null =>
  value === undefined || value === null ? null : accountIn(value, asks, nothing);

const notACommitteeChange = (why: string): RequestError => new RequestError(
  'not-a-committee-change',
  `this asks your wallet to sign a change to who holds a company's rules, and ${why}. Nothing has been shown to `
  + 'them and nothing has been signed.');

/** A committee as this wire carries it, folded to lower case, or the refusal. */
function committeeOnTheWire(value: unknown, which: string): CommitteeOnTheWire {
  if (typeof value !== 'object' || value === null) throw notACommitteeChange(`${which} is not a committee`);
  const v = value as Record<string, unknown>;
  const keys = v['committee'];
  const threshold = v['threshold'];
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_COMMITTEE) {
    throw notACommitteeChange(`${which} lists no keys, or more than ${MAX_COMMITTEE}`);
  }
  const committee = keys.map((k: unknown) => {
    const key = k as Record<string, unknown> | null;
    if (typeof key !== 'object' || key === null || key['tag'] !== 'schnorr'
      || typeof key['value'] !== 'string' || !COMMITTEE_KEY.test(key['value'] as string)) {
      throw notACommitteeChange(`${which} lists a key that is not a committee key a wallet derives`);
    }
    return Object.freeze({ tag: 'schnorr' as const, value: (key['value'] as string).toLowerCase() });
  });
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1 || threshold > committee.length) {
    throw notACommitteeChange(`${which}'s threshold is not a whole number from one to the number of its keys`);
  }
  return Object.freeze({ committee: Object.freeze(committee), threshold });
}

/**
 * **A COMMITTEE CHANGE, READ WHOLE.** The committee to install lists no key
 * twice, because a key listed twice would make the threshold read as more
 * people than it is; every contract names its address once, a counter, and the
 * committee on it now.
 */
function committeeChangeOf(body: Record<string, unknown>, asking: Asking): CommitteeRequest {
  if ('wants' in body) {
    throw new RequestError(
      'attributes-on-a-committee-change',
      'this asks your wallet to sign a change to who holds a company\'s rules, and it also carries a list of '
      + 'details to hand over. Those are two different powers and this wallet will not approve them behind one '
      + 'press, so the whole request is refused. Nothing has been shown to them and nothing has been signed.');
  }
  if ('inboxPublicKey' in body) {
    throw new RequestError(
      'inbox-key-on-a-committee-change',
      'this asks your wallet to sign a change to who holds a company\'s rules, and it also names a key to seal an '
      + 'answer to. The signatures are handed back to the page that asked, so the key is refused rather than '
      + 'ignored. Nothing has been shown to them and nothing has been signed.');
  }
  const committeeAsks = 'this asks your wallet to sign a change to who holds a company\'s rules';
  const committeeNothing = 'Nothing has been shown to them and nothing has been signed.';
  const company = labelIn(body['company'], committeeAsks, committeeNothing);
  const account = accountIn(body['account'], committeeAsks, committeeNothing);
  const to = committeeOnTheWire(body['to'], 'the committee to install');
  if (new Set(to.committee.map((k) => k.value)).size !== to.committee.length) {
    throw notACommitteeChange('the committee to install lists one key twice, so its threshold is not what it reads as');
  }
  const contracts = body['contracts'];
  if (!Array.isArray(contracts) || contracts.length === 0 || contracts.length > MAX_CONTRACTS) {
    throw notACommitteeChange(`it names no contract to change, or more than ${MAX_CONTRACTS}`);
  }
  const seen = new Set<string>();
  const parsed = contracts.map((c: unknown) => {
    const entry = c as Record<string, unknown> | null;
    if (typeof entry !== 'object' || entry === null) throw notACommitteeChange('one of the contracts is not readable');
    const contract = entry['contract'];
    const address = entry['address'];
    const counter = entry['counter'];
    if (contract !== 'account' && contract !== 'vault') {
      throw notACommitteeChange('one of the contracts is neither the company\'s account nor one of its vaults');
    }
    if (typeof address !== 'string' || !CONTRACT_ADDRESS.test(address)) {
      throw notACommitteeChange('one of the contracts is not named by a sixty-four character address');
    }
    /*
     * A vault is born held by the company's committee and sits at counter 0
     * until its first committee change, so 0 is a counter it can be at. The
     * account is at 1 once the second step of its creation has landed: an
     * account at 0 is a creation not finished, which nothing here changes.
     */
    if (typeof counter !== 'string' || !COUNTER.test(counter) || BigInt(counter) < (contract === 'vault' ? 0n : 1n)) {
      throw notACommitteeChange(contract === 'vault'
        ? 'one of the vaults names no counter it can be at'
        : 'the company\'s account is not finished being created, so who holds it cannot be changed yet');
    }
    const folded = address.toLowerCase();
    if (seen.has(folded)) throw notACommitteeChange('it names one contract twice');
    seen.add(folded);
    /* The company's account is the one the ask names beside the label, and no
     * other: the label is read off that account before anything is signed, so
     * an account entry naming a different contract would be signed for a
     * company nobody checked. */
    if (contract === 'account' && folded !== account) {
      throw notACommitteeChange('the account it changes is not the account it names as carrying the company\'s label');
    }
    return Object.freeze({
      contract,
      address: (contract === 'account' ? readAccountAddress(folded) : readVaultAddress(folded)) as AccountAddress | VaultAddress,
      counter: BigInt(counter).toString(),
      now: committeeOnTheWire(entry['now'], 'the committee a contract is held by now'),
    });
  });
  if (parsed.filter((c) => c.contract === 'account').length > 1) {
    throw notACommitteeChange('it names more than one company account');
  }
  return Object.freeze({
    ...asking,
    kind: 'committee' as const,
    company,
    account,
    to,
    contracts: Object.freeze(parsed),
  });
}

const SEAT = /^[0-9a-f]{64}$/u;

/** A records-key ask, read whole: a label, the account that carries it, and one seat. */
function recordsKeyAskOf(body: Record<string, unknown>, asking: Asking): RecordsKeyRequest {
  if ('wants' in body) {
    throw new RequestError(
      'attributes-on-a-records-key',
      'this asks your wallet to sign your records key for your seat on a company\'s account, and it also carries a list '
      + 'of details to hand over. Those are two different powers and this wallet will not approve them behind one '
      + 'press, so the whole request is refused. Nothing has been shown to them and nothing has been signed.');
  }
  if ('inboxPublicKey' in body) {
    throw new RequestError(
      'inbox-key-on-a-records-key',
      'this asks your wallet to sign your records key, and it also names a key to seal an answer to. The answer is '
      + 'handed back to the page that asked, so the key is refused rather than ignored. Nothing has been shown to '
      + 'them and nothing has been signed.');
  }
  const asks = 'this asks your wallet to sign your records key for a company';
  const nothing = 'Nothing has been shown to them and nothing has been signed.';
  const company = labelIn(body['company'], asks, nothing);
  const account = accountIn(body['account'], asks, nothing);
  const seat = body['seat'];
  if (typeof seat !== 'string' || !SEAT.test(seat)) {
    throw new RequestError(
      'not-a-seat',
      `${asks} and names your seat on its account by something that is not one (64 lower-case hex characters). ${nothing}`);
  }
  let signingKey: string | undefined;
  if ('signingKey' in body) {
    const k = body['signingKey'];
    if (typeof k !== 'string' || !SEAT.test(k)) {
      throw new RequestError(
        'malformed-field',
        `${asks} and names the key your filings are signed with by something that is not one (64 lower-case hex characters). ${nothing}`);
    }
    signingKey = k;
  }
  const withKey = signingKey === undefined ? {} : { signingKey };
  if (!('vault' in body)) return Object.freeze({ ...asking, kind: 'records-key' as const, company, account, seat, ...withKey });
  const vault = readVaultAddress(body['vault']);
  if (vault === null || String(vault) === String(account)) {
    throw new RequestError(
      'not-a-vault-address',
      `${asks} and names one of its vaults by something that is not a vault's address on the chain. ${nothing}`);
  }
  return Object.freeze({ ...asking, kind: 'records-key' as const, company, account, seat, vault, ...withKey });
}

/** The most keys one creation inserts, and the most characters one of them may take. */
const MAX_INSERTED = 64;
const MAX_KEY = 16_384;
const CIRCUIT = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** A creation, read whole: a label, the account the deploy creates, the deploy and the keys to insert. */
function creationAskOf(body: Record<string, unknown>, asking: Asking): CreationRequest {
  const asks = 'this asks your wallet to finish creating a company\'s account';
  const nothing = 'Nothing has been shown to them and nothing has been signed.';
  if ('wants' in body) {
    throw new RequestError(
      'attributes-on-a-creation',
      `${asks}, and it also carries a list of details to hand over. Those are two different powers and this wallet will `
      + `not approve them behind one press, so the whole request is refused. ${nothing}`);
  }
  if ('inboxPublicKey' in body) {
    throw new RequestError(
      'inbox-key-on-a-creation',
      `${asks}, and it also names a key to seal an answer to. The answer is handed back to the page that asked, so the `
      + `key is refused rather than ignored. ${nothing}`);
  }
  const company = labelIn(body['company'], asks, nothing);
  const account = accountIn(body['account'], asks, nothing);
  const notOne = (why: string) => new RequestError('not-a-creation', `${asks} and ${why}. ${nothing}`);
  const deploy = body['deploy'];
  if (typeof deploy !== 'string' || deploy.length === 0 || deploy.length > MAX_TRANSACTION || deploy.length % 4 !== 0
    || !TRANSACTION.test(deploy)) {
    throw notOne(`what it sent as the deploy is not one this wallet can read: it must be base64, and no longer than ${MAX_TRANSACTION} characters`);
  }
  const insert = body['insert'];
  if (!Array.isArray(insert) || insert.length === 0 || insert.length > MAX_INSERTED) {
    throw notOne(`it names no key to insert, or more than ${MAX_INSERTED}`);
  }
  const seen = new Set<string>();
  const keys = insert.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) throw notOne('one of the keys to insert is not readable');
    const e = entry as Record<string, unknown>;
    const circuit = e['circuit'];
    const key = e['key'];
    if (typeof circuit !== 'string' || !CIRCUIT.test(circuit)) throw notOne('one of the keys to insert names no circuit');
    if (seen.has(circuit)) throw notOne('it names one circuit twice');
    seen.add(circuit);
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY || key.length % 4 !== 0 || !TRANSACTION.test(key)) {
      throw notOne(`the key for ${circuit} is not base64 of a key file`);
    }
    return Object.freeze({ circuit, key });
  });
  return Object.freeze({ ...asking, kind: 'creation' as const, company, account, deploy, insert: Object.freeze(keys) });
}

/** Every field a holders ask may carry: the ones every ask carries, then its own three. */
const HOLDERS_FIELDS: ReadonlySet<string> = new Set([
  'schema', 'kind', 'requester', 'purpose', 'nonce', 'expiresAt', 'company', 'account',
]);

/** A holders ask, read whole: a label and the account that carries it. */
function holdersAskOf(body: Record<string, unknown>, asking: Asking): HoldersRequest {
  const asks = 'this asks your wallet who holds a company\'s account';
  const nothing = 'Nothing has been shown to them.';
  const extra = Object.keys(body).filter((k) => !HOLDERS_FIELDS.has(k));
  if (extra.length > 0) {
    throw new RequestError(
      'more-than-holders',
      `${asks}, which is answered without a press because it hands over only what the chain shows, and it also `
      + `carries ${extra.map((k) => `'${k}'`).join(', ')}. Anything more than that is refused rather than ignored. ${nothing}`);
  }
  const company = labelIn(body['company'], asks, nothing);
  const account = accountIn(body['account'], asks, nothing);
  return Object.freeze({ ...asking, kind: 'holders' as const, company, account });
}

/**
 * THE ONLY DOOR AN ASK COMES THROUGH.
 *
 * `observedOrigin` is a SEPARATE ARGUMENT because it comes from a different
 * place: `MessageEvent.origin`, which the browser fills in and no page can
 * write. `channel.ts` is what supplies it and does nothing else.
 *
 * The parse is total — every refusal is a named code and nothing throws a
 * `SyntaxError` at a caller matching on a sentence.
 *
 * **THE KIND IS READ AFTER EVERYTHING COMMON AND BEFORE ANYTHING KIND-SPECIFIC**,
 * so the order every refusal a disclosure could already meet arrives in is
 * exactly the order it arrived in before.
 */
export function parseAsk(raw: unknown, observedOrigin: string, now: number): Ask {
  const { body, asking } = common(raw, observedOrigin, now);
  /*
   * **NO KIND OF ASK MAY NAME AN ADDRESS**, so this is checked before the
   * kind is even read, exactly like `origin`. A sign-in and an unlock have no
   * `wants` to hide one in; a disclosure does, and `wantsOf` covers that. This
   * covers the request itself, for all three, in one place.
   */
  if ('address' in body) {
    throw new RequestError(
      'proposes-an-address',
      'this request names an address. A wallet works out where its owner is paid from '
      + 'their own keys and from the wallet they choose on this screen — a request that '
      + 'brought one along is telling somebody where their own money goes, so it is refused '
      + 'rather than ignored. Nothing has been shown to them.');
  }
  const kind = kindOf(body);

  /*
   * **A PERSON AND A SIGNED-IN ADDRESS BELONG TO A KEYRING ASK AND TO NOTHING
   * ELSE.** Refused by presence on every other kind: a requester that named
   * one and was answered with something else would be entitled to believe the
   * wallet had read it.
   */
  if (kind !== 'keyring' && ('person' in body || 'signedInAs' in body || 'drawLabel' in body)) {
    throw new RequestError(
      'keyring-fields-on-another-kind',
      `this is a '${kind}' and it names a person, the address a page signed in as, or asks to start a company. Those `
      + 'belong only to an ask for the key your saved keys at a site are sealed under, so '
      + 'they are refused rather than ignored. Nothing has been shown to them.');
  }

  /*
   * **A TRANSACTION BELONGS TO A BALANCE ASK AND TO NOTHING ELSE, AND A VAULT TO
   * THAT AND TO A RECORDS-KEY ASK**, which reads who holds the vault it names.
   * Refused by presence on every other kind, for the keyring fields' reason: a
   * requester that sent one and was answered with something else would be
   * entitled to believe the wallet had read it.
   */
  if ((kind !== 'balance' && 'transaction' in body)
    || (kind !== 'balance' && kind !== 'records-key' && 'vault' in body)) {
    throw new RequestError(
      'balance-fields-on-another-kind',
      `this is a '${kind}' and it carries a transaction or names a vault. A transaction belongs only to `
      + 'a request to pay for one, and a vault only to that or to a request to sign your records key, so '
      + 'they are refused rather than ignored. Nothing has been shown to them.');
  }

  /*
   * **A COMMITTEE TO INSTALL AND THE CONTRACTS IT GOES ON BELONG TO A
   * COMMITTEE CHANGE AND TO NOTHING ELSE**, refused by presence on every other
   * kind for the keyring fields' reason.
   */
  if (kind !== 'committee' && ('to' in body || 'contracts' in body)) {
    throw new RequestError(
      'committee-fields-on-another-kind',
      `this is a '${kind}' and it names a committee or the contracts a committee holds. Those belong only to a `
      + 'request to sign a change to who holds a company\'s rules, so they are refused rather than ignored. '
      + 'Nothing has been shown to them.');
  }

  /*
   * **A SEAT BELONGS TO A RECORDS-KEY ASK AND TO NOTHING ELSE**, refused by
   * presence on every other kind for the keyring fields' reason.
   */
  if (kind !== 'records-key' && ('seat' in body || 'signingKey' in body)) {
    throw new RequestError(
      'records-key-fields-on-another-kind',
      `this is a '${kind}' and it names a seat on a company's account or a filing key. Those belong only to a request `
      + 'to sign your records key for your seat, so they are refused rather than ignored. Nothing has been shown to them.');
  }

  /*
   * **A DEPLOY AND THE KEYS AN INSERT ADDS BELONG TO A CREATION AND TO NOTHING
   * ELSE**, refused by presence on every other kind for the keyring fields' reason.
   */
  if (kind !== 'creation' && ('deploy' in body || 'insert' in body)) {
    throw new RequestError(
      'creation-fields-on-another-kind',
      `this is a '${kind}' and it carries a deploy or keys to insert. Those belong only to a request to finish creating `
      + 'a company\'s account, so they are refused rather than ignored. Nothing has been shown to them.');
  }

  if (kind === 'committee') return committeeChangeOf(body, asking);
  if (kind === 'creation') return creationAskOf(body, asking);
  if (kind === 'records-key') return recordsKeyAskOf(body, asking);
  if (kind === 'holders') return holdersAskOf(body, asking);

  if (kind === 'balance') {
    if ('wants' in body) {
      throw new RequestError(
        'attributes-on-a-balance',
        'this asks your wallet to pay for a transaction, and it also carries a list of details '
        + 'to hand over. Those are two different powers and this wallet will not approve them '
        + 'behind one press, so the whole request is refused. Nothing has been shown to them '
        + 'and nothing has been paid.');
    }
    if ('inboxPublicKey' in body) {
      throw new RequestError(
        'inbox-key-on-a-balance',
        'this asks your wallet to pay for a transaction, and it also names a key to seal an '
        + 'answer to. A paid transaction is handed back to the page that asked, so the key is '
        + 'refused rather than ignored. Nothing has been shown to them and nothing has been paid.');
    }
    const balanceAsks = 'this asks your wallet to pay into a company';
    const balanceNothing = 'Nothing has been shown to them and nothing has been paid.';
    const company = labelIn(body['company'], balanceAsks, balanceNothing);
    const account = accountIn(body['account'], balanceAsks, balanceNothing);
    const vault = readVaultAddress(body['vault']);
    if (vault === null) {
      throw new RequestError(
        'not-a-vault-address',
        'this asks your wallet to pay into a vault and does not name one this wallet can make '
        + 'sense of. A vault is named by its own sixty-four character address on the chain. '
        + 'Nothing has been shown to them and nothing has been paid.');
    }
    const transaction = body['transaction'];
    if (typeof transaction !== 'string' || transaction.length === 0
      || transaction.length > MAX_TRANSACTION || transaction.length % 4 !== 0
      || !TRANSACTION.test(transaction)) {
      throw new RequestError(
        'not-a-transaction',
        'this asks your wallet to pay for a transaction and what it sent is not one this wallet '
        + `can read: it must be base64, and no longer than ${MAX_TRANSACTION} characters. `
        + 'Nothing has been shown to them and nothing has been paid.');
    }
    return Object.freeze({
      ...asking,
      kind,
      company,
      account,
      vault,
      transaction,
    });
  }

  if (kind === 'keyring') {
    if ('wants' in body) {
      throw new RequestError(
        'attributes-on-a-keyring',
        'this asks for the key your saved keys at this site are sealed under, and it also '
        + 'carries a list of details to hand over. Those are two different powers and this '
        + 'wallet will not approve them behind one press, so the whole request is refused. '
        + 'Nothing has been shown to them and nothing has been released.');
    }
    if ('inboxPublicKey' in body) {
      throw new RequestError(
        'inbox-key-on-a-keyring',
        'this asks for the key your saved keys at this site are sealed under, and it also '
        + 'names a key to seal an answer to. A release is not sealed to anybody, so the '
        + 'request is refused rather than half honoured. Nothing has been shown to them and '
        + 'nothing has been released.');
    }
    const person = body['person'];
    if (typeof person !== 'string' || !PERSON.test(person)) {
      throw new RequestError(
        'not-a-person',
        'this asks for the key your saved keys at a site are sealed under and does not name '
        + 'you in a way this wallet can use. Nothing has been shown to them and nothing has '
        + 'been given.');
    }
    const signedInAs = body['signedInAs'];
    if (signedInAs !== undefined && signedInAs !== null
      && (typeof signedInAs !== 'string' || signedInAs.length > 300
        || !SIGNED_IN_ADDRESS.test(signedInAs))) {
      throw new RequestError(
        'not-a-signed-in-address',
        'this names the wallet address the page signed in as, and what it names is not an '
        + 'address. Nothing has been shown to them and nothing has been given.');
    }
    const keyringAsks = 'this also asks for the key to a company';
    const keyringNothing = 'Nothing has been shown to them and nothing has been given.';
    const rawCompany = body['company'];
    const company = rawCompany === undefined || rawCompany === null
      ? null : labelIn(rawCompany, keyringAsks, keyringNothing);
    const account = accountMaybeIn(body['account'], keyringAsks, keyringNothing);
    const drawLabel = body['drawLabel'];
    if (drawLabel !== undefined && typeof drawLabel !== 'boolean') {
      throw new RequestError(
        'malformed-field',
        'this says whether your wallet should start a new company, and says it as something other than '
        + `yes or no. ${keyringNothing}`);
    }
    /* A new company has no label yet and no account, so an ask to start one
     * that also names either is two questions behind one press. */
    if (drawLabel === true && (company !== null || account !== null)) {
      throw new RequestError(
        'malformed-field',
        'this asks your wallet to start a new company and also names a company or an account. A new '
        + `company has neither yet. ${keyringNothing}`);
    }
    if (company === null && account !== null) {
      throw new RequestError(
        'malformed-field',
        `this names a company's account and no company. ${keyringNothing}`);
    }
    return Object.freeze({
      ...asking,
      kind,
      person,
      signedInAs: typeof signedInAs === 'string' ? signedInAs : null,
      company,
      account,
      drawLabel: drawLabel === true,
    });
  }

  if (kind === 'sign-in') {
    /*
     * REFUSED BY PRESENCE, NOT BY CONTENT — the same rule as `origin`, and for
     * the same reason. `wants: []` is refused too: the field is not checked
     * here, it is ABSENT, and a requester that sent one and was answered would
     * be entitled to believe the wallet had considered it.
     */
    /* A SIGN-IN OPENS NOTHING, SO IT HAS NO COMPANY TO NAME. Refused by
     * presence, like `wants` beside it: a requester that named a company and
     * was answered anyway would be entitled to believe the wallet had read it. */
    if ('company' in body || 'account' in body) {
      throw new RequestError(
        'company-on-a-sign-in',
        'this is a sign-in and it names a company whose records to open. Signing in opens '
        + 'nothing, so the name is refused rather than ignored. Nothing has been shown to '
        + 'them.');
    }
    if ('wants' in body) {
      throw new RequestError(
        'attributes-on-a-sign-in',
        'this is a sign-in and it carries a list of details to hand over. A sign-in asks '
        + 'one question and asks for nothing, so the list is refused rather than ignored — '
        + 'ignoring it would leave whoever sent it believing it had been honoured. Nothing '
        + 'has been shown to them.');
    }
    /* A SIGN-IN SENDS NOTHING, SO THERE IS NOTHING TO SEAL. Refused by
     * presence, like the two above it and for the same reason. */
    if ('inboxPublicKey' in body) {
      throw new RequestError(
        'inbox-key-on-a-sign-in',
        'this is a sign-in and it names a key to seal an answer to. A sign-in sends '
        + 'nothing that could be sealed, so the key is refused rather than ignored. '
        + 'Nothing has been shown to them.');
    }
    return Object.freeze({ ...asking, kind });
  }

  if (kind === 'unlock') {
    /*
     * THE SAME REFUSAL, BY PRESENCE, AND ITS OWN NAME.
     *
     * An unlock is not a disclosure that also hands over a key: **the two are
     * different powers and a screen approving both at once could not be read.**
     * A request carrying both is refused rather than half-honoured, and the
     * code says which kind it was, because a refusal naming the wrong kind
     * tells a requester something untrue about its own message.
     */
    if ('wants' in body) {
      throw new RequestError(
        'attributes-on-an-unlock',
        'this asks for the key to what this site holds for you, and it also carries a list '
        + 'of details to hand over. Those are two different powers and this wallet will not '
        + 'approve them behind one press, so the whole request is refused rather than half '
        + 'of it honoured. Nothing has been shown to them and nothing has been released.');
    }
    /*
     * **THE ONE CLAIMED VALUE, AND ITS SHAPE IS THE WHOLE OF WHAT CAN BE
     * CHECKED HERE.** Nothing in this wallet can tell whether the person really
     * belongs to the company at this address; that is what the screen is for.
     * What this can tell is whether the request knows what it is asking for.
     */
    const unlockAsks = 'this asks for the key to a company';
    const unlockNothing = 'Nothing has been shown to them and nothing has been given.';
    const company = labelIn(body['company'], unlockAsks, unlockNothing);
    const account = accountMaybeIn(body['account'], unlockAsks, unlockNothing);
    /* AN UNLOCK RELEASES A KEY OVER THE CHANNEL AND SEALS NOTHING.
     * Refused by presence: a requester that named an inbox key and was answered
     * anyway would be entitled to believe the release had been sealed to it. */
    if ('inboxPublicKey' in body) {
      throw new RequestError(
        'inbox-key-on-an-unlock',
        'this asks for the key to what this site holds for you, and it also names a key '
        + 'to seal an answer to. A release is not sealed to anybody, so the second key is '
        + 'refused rather than ignored. Nothing has been shown to them and nothing has '
        + 'been released.');
    }
    return Object.freeze({ ...asking, kind, company, account });
  }

  if (kind === 'join') {
    /*
     * **A JOIN NAMES AN INBOX, NOT A COMPANY'S RECORDS.** Its own code:
     * a request carrying both is asking for two different powers behind one
     * press, which is the refusal written for `wants` on an unlock, and naming
     * the wrong kind in it would tell a requester something untrue about its
     * own message.
     */
    if ('company' in body || 'account' in body) {
      throw new RequestError(
        'company-on-a-join',
        'this is an invitation and it also names a company whose records to open. Those '
        + 'are two different things and this wallet will not answer both behind one press, '
        + 'so the whole request is refused rather than half of it honoured. Nothing has '
        + 'been shown to them.');
    }
    /*
     * **THE SHAPE IS THE WHOLE OF WHAT CAN BE CHECKED HERE, AND SAYING SO IS
     * THE POINT.** Nothing in this wallet can tell whether this key belongs to
     * the company on the page -- that is what the screen is for, and the screen
     * says it in those words. What this can tell is whether the request knows
     * what it is asking for: a malformed key is an acceptance nobody can open,
     * and sealing to one would destroy the answer rather than deliver it.
     */
    const inbox = body['inboxPublicKey'];
    if (typeof inbox !== 'string' || !INBOX_PUBLIC_KEY.test(inbox)) {
      throw new RequestError(
        'not-an-inbox-key',
        'this invitation does not name a key this wallet can seal an answer to. It is '
        + 'sixty-four characters of hex, and what arrived is not. Nothing would be able '
        + 'to open what was sent, so nothing has been shown to them and nothing has been '
        + 'sent.');
    }
    const wants = wantsOf(body);
    /*
     * **THE ONE REFUSAL THE WALLET OWNS ABOUT WHAT A JOIN ASKS FOR.**
     *
     * **AN INVITATION THAT NEVER ASKS WHERE TO PAY SOMEBODY IS NOT AN
     * INVITATION.** Accepting one would be meaningless -- there is nowhere to
     * pay the person -- so a company that asks for a name and not an address is
     * asking for something other than what this kind is, and is told so by
     * name.
     *
     * **THIS IS NOT THE WALLET FIXING THE COMPANY'S LIST, AND THE DISTINCTION
     * IS THE WHOLE OF WHY IT BELONGS HERE.** The company still chooses every
     * attribute it asks for, in whatever order, with whatever reasons; nothing
     * is added to `wants` and nothing is reordered. What is refused is a
     * MESSAGE WHOSE SHAPE CONTRADICTS ITS OWN KIND -- the same class as the
     * inbox key above and as `company-on-a-join`, and the same class as a
     * sign-in that carries `wants`. **The kind's definition is this file's; the
     * contents of the list are not.**
     *
     * **AND IT MUST BE `required`.** An invitation that marks the address
     * optional is saying *you may join without telling us where to pay you*,
     * which is the same emptiness one step removed -- and `required` is what
     * the approval screen reads to warn a person who declines it. Refusing the
     * optional spelling is what stops that warning being silently unreachable.
     *
     * **WHAT THIS DOES NOT DO IS MAKE THE ROW UNREFUSABLE.** The company must
     * ASK; the person may still decline, as they may decline any row (§6). The
     * two are different halves and both are deliberate: the refusal is about a
     * message the wallet cannot answer, and the decline is about an answer the
     * person is entitled to give. `screens/approve.tsx` says out loud what a
     * declined address means, which is the other half of choosing this pair.
     *
     * The one attribute named in this file, and it is named because it is the
     * one thing in this protocol that MONEY FOLLOWS.
     */
    if (!wants.some((w) => w.attribute === RECEIVING_ADDRESS && w.required)) {
      throw new RequestError(
        'not-an-invitation',
        `this calls itself an invitation and never asks for '${RECEIVING_ADDRESS}' as `
        + 'something it requires. Accepting an invitation is handing a company somewhere '
        + 'to pay you, so one that does not ask for that is asking for something else and '
        + 'is refused rather than shown as an invitation. Ask for it as an ordinary '
        + 'request for details instead. Nothing has been shown to them.');
    }
    /* The canonical spelling, from here inward. */
    return Object.freeze({ ...asking, kind, inboxPublicKey: inbox.toLowerCase(), wants });
  }

  /* A DISCLOSURE OPENS NOTHING EITHER. Same refusal, its own code. */
  if ('company' in body || 'account' in body) {
    throw new RequestError(
      'company-on-a-disclosure',
      'this asks for details about you and also names a company whose records to open. '
      + 'Those are two different things and this wallet will not answer both behind one '
      + 'press, so the whole request is refused rather than half of it honoured. Nothing '
      + 'has been shown to them.');
  }
  /*
   * **A DISCLOSURE ANSWERS IN THE CLEAR OVER THE CHANNEL, SO IT HAS
   * NOTHING TO SEAL TO.** Refused by presence and with its own code.
   *
   * **THIS IS ALSO THE FAIL-CLOSED EDGE FOR THE FOURTH KIND, IN BOTH
   * DIRECTIONS.** An absent `kind` is still a disclosure (the header says why),
   * so stripping `kind: 'join'` off an invitation in flight leaves a disclosure
   * carrying an inbox key -- refused here. Adding `kind: 'join'` to a
   * disclosure leaves a join with no inbox key -- refused above. **Neither edit
   * of this field yields something a person is asked to approve**, and neither
   * yields an address answered in the clear to a page that asked to have it
   * sealed.
   */
  if ('inboxPublicKey' in body) {
    throw new RequestError(
      'inbox-key-on-a-disclosure',
      'this asks for details about you and also names a key to seal the answer to. A '
      + 'disclosure is answered over the channel to the page that asked, so the key is '
      + 'refused rather than ignored -- ignoring it would leave whoever sent it believing '
      + 'their answer had been sealed. Nothing has been shown to them.');
  }
  return Object.freeze({ ...asking, kind, wants: wantsOf(body) });
}

/**
 * THE SAME DOOR, NARROWED TO A DISCLOSURE.
 *
 * A disclosure and a sign-in are different types because they are different
 * asks, and everything that renders rows — `asked` below, `rowsFor` on the
 * screen — needs the one that has rows. This refuses the other **by name**
 * rather than by returning something with an empty list, which is the whole
 * argument of this change in one function.
 */
export function parseRequest(
  raw: unknown, observedOrigin: string, now: number,
): DisclosureRequest {
  const ask = parseAsk(raw, observedOrigin, now);
  if (ask.kind !== 'disclosure') {
    throw new RequestError(
      'not-a-disclosure',
      `that is a '${ask.kind}', and this asked for a request for details.`);
  }
  return ask;
}

/**
 * WHAT THE PERSON IS SHOWN, ONE ROW PER THING ASKED FOR.
 *
 * An attribute this vocabulary does not know is a row that says so. It is NOT
 * dropped — a request asking for six things and a screen showing five is a
 * screen lying about what was asked — and it is not turned into an attribute.
 * `definition` is `null` and the screen renders the raw name as text.
 */
export interface Asked {
  readonly want: Want;
  readonly known: boolean;
}

export const asked = (request: Wanting, registry: Registry): readonly Asked[] =>
  Object.freeze(request.wants.map((want) => Object.freeze({
    want, known: registry.knows(want.attribute),
  })));

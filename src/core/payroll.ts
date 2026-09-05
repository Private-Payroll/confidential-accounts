import { nanoid } from 'nanoid';
import {
  newWrappingKeypair, newSymmetricKey, wrapKey, unwrapKey, seal, unseal, canonical,
  parseCanonical, toHex, utf8, type Hex, type Sealed,
} from './crypto.js';
import { sha256 as sha256Bytes } from '@noble/hashes/sha2.js';
import { inviteKeyOf } from './store.js';
import { companyAddressForOffer } from './company-address.js';
import { newWords } from 'midnight-identity';
/* `PI4c` — the code the payee's wallet produced, checked where the roster is
 * written. `C21`. Same function the admin's browser runs, one module, so the two
 * sides of the comparison cannot drift apart. */
import { addressFingerprint, FingerprintError } from 'midnight-identity/profile/fingerprint';
import { payslipKeypairForWallet } from './payslip-key.js';

/**
 * **THE ORIGIN THE SEED'S STAND-IN WALLET IS ASKED AT, AND IT IS NOT AN
 * INGREDIENT.** `PI2b`.
 *
 * `unlock.ts` gates on the origin and derives from the company alone
 * (`W3`), so this value cannot change a single byte of any key. It exists
 * because the wallet refuses to answer an origin it cannot make sense of, and
 * something has to be passed. **A test asserts that two different origins give
 * the same key**, which is what keeps this from quietly becoming load bearing.
 */
const SEED_WALLET_ORIGIN = 'https://payroll.example';
import type { AssetId } from './assets.js';
import { assets as defaultAssets, subtotals, formatAmount, assetIdBytes } from './assets.js';
import type { Account, Employee, PayrollRun, SealedRun, ShieldedEntry, Attestation, RosterEmployee, SealedEmployee, Invite, User } from './types.js';
import { sealRecord, openRecord, sealToInbox, openFromInbox } from './sealed-records.js';
import {
  sealHandover, openHandover, type SealedHandover,
} from './invite-handover.js';
import {
  payeeAddressFromKeys, payeeOf, type Payee, type PayeeAddress,
} from '../midnight/payee-address.js';
import { payrollPayee } from './movement.js';
import type { NetworkName } from '../midnight/network.js';
import type { ShieldedPaymentFacts } from '../midnight/payout-tree.js';

/**
 * The private half of a roster entry — everything a salary slip is built from.
 *
 * Split out because this, and only this, is what gets sealed. `id` and
 * `accountId` stay outside so a record can be found without opening it.
 */
type EmployeeSecrets = Omit<RosterEmployee, 'id' | 'accountId' | 'wrappingPublicKey' | 'status'>;

/**
 * The key an invite's offer is sealed under: derived from the RAW token.
 *
 * Domain-separated from the lookup hash, so the value we STORE can never be the
 * value that decrypts. `inviteKeyOf` is `sha256(token)`; this is
 * `sha256("midnight-invite-offer:" + token)`. Knowing one tells you nothing
 * about the other, which is the whole point — the first is in our database and
 * the second must not be derivable from it.
 */
const offerKeyOf = (token: string): Hex =>
  toHex(sha256Bytes(utf8('midnight-invite-offer:' + token)));

/**
 * **HOW LONG AN OFFER IS AN OFFER.** `X12` §3,
 * `docs/scope-invitations.md` §8 and §9.
 *
 * *"An offer that never expires is a salary waiting for whoever eventually
 * finds that link."* — and the link is a bearer credential travelling through
 * whatever channel an admin already uses to talk to somebody, which is to say
 * through a chat history that is still there next year.
 *
 * **FOURTEEN DAYS, AND THE NUMBER IS A TRADE RATHER THAN A DEFAULT.** Shorter
 * is safer and there is a cost on the other side that is not theoretical: an
 * invitation that has expired cannot be re-opened — nothing can re-seal the
 * offer, because only the holder of the raw token can (`acceptInvite`'s note on
 * the put-back is the same fact from the other end) — so an expiry is a
 * withdraw and a re-invite, by hand, for somebody who was on holiday. Two weeks
 * covers a fortnight's leave and is far short of the life of a chat log.
 *
 * It is one constant rather than a per-invitation choice because a screen that
 * offers a deadline offers a person the chance to set it to a year.
 */
export const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * A deterministic stand-in address, for seeding and tests ONLY.
 *
 * Real addresses come from a person's own device or wallet and never from here.
 * This exists so `hireDirect` can walk the SAME two steps the real flow walks —
 * hand over, then admit — rather than reaching past them into a roster state
 * that no onboarding can actually produce.
 *
 * The two halves are derived differently from each other on purpose. A fixture
 * whose coin key and reading key were equal would make every crossed-pair
 * assertion in the suite pass while proving nothing.
 */
const addressOf = (
  spec: EmployeeSpec, existing?: RosterEmployee,
): string | null => {
  if (!existing) return null;
  if (existing.name !== spec.name) {
    throw new Error(
      `the roster entry beside ${spec.name} on this run is ${existing.name}. `
      + 'Refusing rather than printing one payee\'s address on another\'s payslip.');
  }
  return existing.address?.bech32 ?? null;
};

const seededAddress = (employeeId: string, network: NetworkName): PayeeAddress => {
  const from = (tag: string): Hex => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = (tag.charCodeAt(i % tag.length) + i * 7 + employeeId.charCodeAt(i % employeeId.length)) & 0xff;
    }
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  };
  return payeeAddressFromKeys(
    { coinPublicKey: from('coin'), encryptionPublicKey: from('read') }, network);
};

/**
 * HOW AN INVITE REACHES THE PERSON IT IS FOR. A-10, as corrected.
 *
 * The token used to be handed back to whoever raised it, and that was the whole
 * hole: an operator holding a bearer token can redeem it themselves with an
 * address they control, and somebody else's salary is set for good. Every guard
 * built on top of that — comparing who minted it to who redeemed it — is proving
 * a negative, and a second identity costs one email address.
 *
 * **So the token is DELIVERED and never returned.** It goes to the email on the
 * person's own sealed roster entry, which the operator supplied when hiring them
 * but does not have to hold afterwards. That turns the check from "was this
 * somebody other than the person who raised it" into "did this reach the person
 * it was addressed to", which is a positive and is the thing that actually
 * matters.
 *
 * An interface rather than a mailer, because sending email is infrastructure and
 * this file is not the place for it — and because a test needs to read what was
 * sent without an SMTP server in the loop.
 */
export interface InviteDelivery {
  send(to: { email: string; name: string }, token: string, accountId: string): void;
  /**
   * Whether this actually reaches anybody.
   *
   * **Required rather than optional, because the answer today is `false` and an
   * operator must not be left telling an employee to check an inbox nothing was
   * sent to.** A recorder that presented itself as a mailer would produce a
   * roster full of people who cannot be onboarded and a payroll that will not
   * build, with nothing anywhere saying why.
   */
  readonly delivers: boolean;
  /**
   * Drop whatever is still held for this person. Called when their handover is
   * admitted, which is the moment the token stops being useful. `C30`.
   *
   * Optional because a real mailer has nothing to forget — it hands the message
   * to a mail server and keeps none of it. The recorder does, and what it keeps
   * is a raw token beside a name, an email and an account id, in the same
   * process as the ciphertext that token opens.
   */
  forget?(email: string): void;
}

/**
 * The default: keeps what it was given in memory.
 *
 * **It is not a mailer and does not pretend to be one.** Nothing in this repo
 * sends email yet, and a delivery port that silently dropped invites would be
 * worse than one that says where they went — an operator would be left telling
 * an employee to check an inbox nothing was sent to.
 */
export class RecordingInviteDelivery implements InviteDelivery {
  /** Nothing is sent. Saying so is the whole reason this field exists. */
  readonly delivers = false;
  readonly sent: Array<{ email: string; name: string; token: string; accountId: string }> = [];
  send(to: { email: string; name: string }, token: string, accountId: string): void {
    this.sent.push({ ...to, token, accountId });
  }
  /**
   * `C30`, found by audit 17 Aug. Hashing the stored token protects the
   * database; it does nothing about this array, which held every raw token for
   * the life of the process with the name and email in the clear beside it —
   * `S-9`'s mapping, unsealed, next to the ciphertext it opens.
   *
   * Forgetting on admit is a narrowing, not a fix: an invite that is never
   * redeemed is still held for ever, and the token still travels in a URL
   * path. Both are on the register rather than claimed closed here.
   */
  forget(email: string): void {
    const same = email.trim().toLowerCase();
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]!.email.trim().toLowerCase() === same) this.sent.splice(i, 1);
    }
  }
  /** The token for one person, for tests and for a development console. */
  tokenFor(email: string): string {
    const found = [...this.sent].reverse().find(s => s.email === email);
    if (!found) throw new Error(`nothing was sent to ${email}`);
    return found.token;
  }
}

/** The numbers on a run. Everything else about it is operational. S-9. */
type RunSecrets = Pick<PayrollRun, 'employees' | 'totals' | 'proposalIds'>;
import type { AccountService } from './account.js';
import type { ProofSystem, RunProposal } from './ledger.js';
import type { DataStore } from './store.js';

export interface EmployeeSpec {
  name: string;
  /** What actually moves for this person. */
  asset: AssetId;
  /** In `asset`'s smallest unit. */
  amount: bigint;
}

export interface HireSpec {
  name: string;
  /**
   * **NULL FOR A PERSON WITH NO EMAIL, AND NEVER AN EMPTY STRING.** `X8`.
   *
   * `RosterEmployee.email` carries the whole argument. What matters at this
   * type is that the two doors below treat it differently and say so: `invite`
   * REFUSES a null — an invitation is addressed to somebody and one that names
   * nobody could not be delivered or checked against — and `addSelfAsPayee`
   * accepts it, because the caller and the payee are the same person by
   * construction and there is nobody to address.
   */
  email: string | null;
  title: string;
  /** What they are paid in. One asset; there are no exchange rates here. */
  asset: AssetId;
  /** Monthly gross, in `asset`'s smallest unit. */
  baseAmount: bigint;
  startDate?: string;
}

export interface EmployeeSecret {
  employeeId: string;
  name: string;
  /**
   * **STILL HERE, AND NO LONGER A RANDOM NUMBER.** `PI2b`, `C135`.
   *
   * Every caller that opens a payslip still takes this, so nothing about the
   * sealing guarantee or the tests that hold it moves. What changed is where it
   * comes from: `hireDirect` used to mint it with
   * `x25519.utils.randomSecretKey()` and hand over the only copy in
   * existence. It is now `payslipKeypairForWallet(words, …)` — **a value that
   * can be worked out again from `words` on any device, for ever.**
   */
  wrappingSecret: Hex;
  /**
   * **WHAT THE SECRET ABOVE IS DERIVED FROM, AND THE WHOLE OF `C135`'s FIX.**
   *
   * The person's own wallet. Given back by the seed because the seed is
   * standing in for eight people's devices and has to hold what each of them
   * would hold — see `hireDirect`'s header, and `C13`. **A real employee's
   * words never reach this server**, and nothing in this product persists this
   * field: it is returned once, exactly as `wrappingSecret` always was.
   *
   * A random key has to be kept and a kept key can be lost. This one is a pure
   * function of twenty-four words and a chain address, so a person who still
   * has their wallet still has every payslip they were ever issued.
   *
   * **ABSENT MEANS THE SECRET ABOVE IS A RANDOM NUMBER THAT NOTHING CAN WORK
   * OUT AGAIN**, and that is not a formality — it is the one remaining place
   * `C135` is still true. An AD HOC run pays somebody with no roster entry,
   * so there is no wallet to derive from and `createRun` mints one
   * (`payroll.ts`, the `else` branch below). The field is optional so that
   * the difference is visible in the type rather than in a comment: **a secret
   * with no words beside it is a secret somebody has to keep.**
   */
  words?: string[];
}

/**
 * The isolation guarantee here is cryptographic, not a UI filter.
 *
 * Each payslip is sealed to that employee's own key. The account viewing key
 * does not open it, and no other employee's key opens it. An employee who
 * queries this API with their own secret can decrypt exactly one payslip.
 *
 * Settlement is a single aggregate transfer, so an outside observer sees the
 * total leaving the account and never the split.
 */
export class PayrollService {
  constructor(
    private store: DataStore,
    private accounts: AccountService,
    private proofs: ProofSystem,
    private assets = defaultAssets,
    /**
     * WHICH NETWORK THIS COMPANY'S MONEY IS ON. A-2.
     *
     * Load bearing rather than decoration: `admit` re-parses a handed-over
     * address against THIS, not against the network the handover claims for
     * itself. An employee who pastes a preview address into a stagenet company
     * is refused at onboarding, which is free, instead of at payment time,
     * which is not — and a coin public key is network-independent bytes, so
     * nothing further down would have objected.
     */
    private network: NetworkName = 'undeployed',
    /** How an employee invite reaches the employee. Never the operator. A-10. */
    private delivery: InviteDelivery = new RecordingInviteDelivery(),
  ) {}

  /* ---------------- roster ---------------- */

  /**
   * Adds someone to the roster as pending and issues an invite. No key is
   * generated here on purpose: if the employer generated the employee's key the
   * employer could read the payslip, and the guarantee collapses. Until the
   * employee's own device sends a public key, nothing can be sealed to them.
   */
  invite(
    accountId: string, spec: HireSpec, viewingKey: Hex,
    /**
     * WHO IS MINTING THIS TOKEN. A-10.
     *
     * Recorded so `admit` can RECORD a handover redeemed by the same person who
     * raised it — as `selfRaised`, visible to an admin. It used to REFUSE; that
     * refusal asked about the wrong person, and its price was a second flow for
     * founders, which became `C24`. Nullable rather than optional so a call site that has no user
     * — a seed, a test — has to say so out loud instead of forgetting.
     */
    createdBy: string | null = null,
  ): {
    employee: RosterEmployee; sentTo: string; delivered: boolean;
    /**
     * **THE LINK, ONCE.** `X11` §1. See the note where it is returned: this is
     * the only moment the raw token is ever visible, and every listing route
     * strips it from here on.
     */
    raw: string;
  } {
    /*
     * **AN INVITATION IS ADDRESSED TO SOMEBODY.** `X8`.
     *
     * `HireSpec.email` became nullable so that `addSelfAsPayee` can write a
     * record about a person who has no email. **This door is the other case and
     * it must not inherit that.** An invite with no email cannot be delivered,
     * and `admit`'s positive check — *is the redeemer the person the company
     * said it was hiring* — has nothing to compare, so an unaddressed
     * invitation is a bearer token with no owner. Refused here rather than
     * discovered at the moment somebody redeems it.
     *
     * The blank is refused too, and for the reason the null exists: an empty
     * string compares equal to another empty string, and this is the field two
     * people would be compared by.
     */
    if (spec.email === null || spec.email.trim() === '') {
      throw new Error(
        'an invitation is addressed to somebody, and this one names nobody. Somebody with '
        + 'no email address adds themselves as a payee from their own sign-in; they cannot '
        + 'be invited, because there is nothing to send an invitation to and nothing to '
        + 'check the person who redeems it against');
    }
    const { raw, sentTo, ...rest } = this.raise(accountId, spec, viewingKey, createdBy);
    /*
     * **THE RAW TOKEN COMES BACK TO WHOEVER RAISED IT, AND THIS REVERSES
     * `A-10`. DELIBERATELY, WITH THE ARGUMENT.** `X11` §1,
     * `docs/scope-invitations.md` §4 decision 1, 22 Aug.
     *
     * `A-10` dropped it here, on the reasoning that *the token does not come
     * back to the caller, so an operator cannot redeem it*. That reasoning
     * assumed a MAILER — a channel that reaches the employee without passing
     * through the admin's hands. **There is no mailer and there is not going to
     * be one. Decided 22 Aug:** the admin is hiring this person and already
     * holds their email in their own systems, so we produce a link and they
     * send it. **So we never learn the employee's email address at
     * all** — not in a column, not in a provider's logs, not in a bounce report
     * — which is a stronger property than sending it carefully.
     *
     * A channel that requires the admin to hold the link and a rule that
     * forbids the admin from holding the link cannot both stand. Until today
     * the rule won, and the consequence is that **nobody has ever been hired by
     * this product**: `delivers` is false, the token reached nobody, and one
     * pending person freezes an entire account's payroll.
     *
     * ── WHAT THIS COSTS, MEASURED RATHER THAN WAVED AT ───────────────────
     *
     * An operator holding a raw token can redeem it themselves. **That is
     * `C21`, it is already open, and it has already been reproduced end to
     * end** — an operator types the employee's email at hire time, registers a
     * second identity at a mailbox they own, redeems with an address they hold,
     * and admits; every refusal passes, because the operator controls BOTH
     * sides of the only positive check in the flow. This line does not create
     * that capability and does not widen it: it removes one step from an attack
     * that costs one throwaway address and one registration either way.
     *
     * **AND IT WAS NEVER TRUE THAT THE PROCESS DID NOT HOLD ONE.**
     * `RecordingInviteDelivery` keeps every raw token it is given, in memory,
     * for the life of the process, with the name and the email in the clear
     * beside it — `C8`. The rule this reverses was already only a rule about
     * which VARIABLE held it.
     *
     * ── WHAT DOES NOT CHANGE, AND IS WHAT THE ROUND'S FIRST RULE MEANS ───
     *
     * **No operator-side control OPENS an invitation.** The button that did was
     * deleted on 17 Aug and is not coming back — not behind a flag, not "for
     * development" — because whoever opens an invitation sets the address the
     * salary is paid to. And the token is returned exactly ONCE, on this
     * response: **every listing route strips it**, so it is unreachable from
     * the moment this call returns. `src/server/invitations.test.ts` is what
     * holds both.
     */
    return { ...rest, sentTo: sentTo as string, raw };
  }

  /**
   * Raises an invite and returns the RAW token with it.
   *
   * PRIVATE, and it is the only thing in this file that ever sees one after it
   * is minted. `invite()` drops it, so no caller outside can receive one — that
   * is what makes "the token reaches the person and nobody else" true rather
   * than asserted. The two internal callers that need it, `hireDirect` and
   * `addSelfAsPayee`, are both cases where the redeemer is not a third party.
   */
  private raise(
    accountId: string, spec: HireSpec, viewingKey: Hex, createdBy: string | null,
  ): { employee: RosterEmployee; sentTo: string | null; delivered: boolean; raw: string } {
    this.accounts.require(accountId);
    // Resolved, not trusted: an asset with no registry row has no decimals, so
    // nothing downstream could say what the integer means.
    this.assets.require(spec.asset);
    if (typeof spec.baseAmount !== 'bigint') {
      throw new Error('baseAmount must be a bigint in the asset\'s smallest unit');
    }
    if (spec.baseAmount <= 0n) throw new Error('salary must be positive');
    /* Before a record is sealed with it, not after. `C25`. */
    this.requireKeyFor(accountId, viewingKey);
    const employee: RosterEmployee = {
      id: 'emp_' + nanoid(10),
      accountId,
      name: spec.name,
      email: spec.email,
      title: spec.title,
      baseAmount: spec.baseAmount,
      asset: spec.asset,
      startDate: spec.startDate ?? new Date().toISOString().slice(0, 10),
      status: 'pending',
      wrappingPublicKey: null,
      /* Not ours to supply. It comes from their device, through the drop box. */
      address: null,
      handedOverBy: null,
      admittedBy: null,
      admittedAt: null,
      selfRaised: false,
    };
    this.putPerson(employee, viewingKey);

    /*
     * The invite carries NO name, email or salary. S-9.
     *
     * It used to carry all four, duplicating what the employee record already
     * holds — so sealing the roster while leaving this alone would have moved
     * the leak rather than closed it, and left two copies of a salary that
     * could disagree. The record is the one copy; this points at it.
     */
    /*
     * The raw token exists here and in the message that carries it, and nowhere
     * else. What is stored is its hash — see `Invite.token` — and the offer is
     * sealed under a key derived from the raw one, so **only the person holding
     * it can read what they are being offered, and we cannot.** A-7.
     */
    const raw = 'inv_' + nanoid(18);
    const invite: Invite = {
      token: inviteKeyOf(raw),
      accountId, kind: 'employee',
      createdAt: new Date().toISOString(),
      createdBy,
      /*
       * **EVERY INVITATION HAS A DEADLINE, AND IT IS SET WHERE ONE IS MADE
       * RATHER THAN WHERE ONE IS SHOWN.** `X12` §3,
       * `docs/scope-invitations.md` §9: *no invitation without an expiry*. A
       * door that could mint one without a deadline is a door somebody calls.
       */
      expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS).toISOString(),
      subjectId: employee.id,
      /*
       * **X11 §0 — THE OFFER NAMES THE COMPANY TWICE, AND THE SECOND ONE IS
       * NOT A LABEL.**
       *
       * `company` is a NAME, for a person to read. **`companyAddress` is the
       * company's own account contract address**, and it is here because the
       * key that opens this person's payslips is
       * `payslipKeypairFrom(companyKey)` and the wallet derives that company
       * key from the address and from nothing else (`W3`, `C136`). An invitee
       * is by definition not a member, so `companyForSession` cannot serve
       * them and `POST /api/accounts/:id/unlock` is shut to them — **and
       * inventing a second key path for invitees is what `X11` §0 forbids by
       * name.** It travels here or the invitee derives a key nobody else can
       * reproduce, which is `C135`.
       *
       * **`inboxPublicKey` is here for the same round's other half.** `X11`
       * §7 moves the sealing of the receiving address onto the invitee's own
       * device, and a browser cannot seal to an inbox it has not been given.
       * `sealed-records.ts` says of this value, in its own words, *"Safe to
       * store and serve in the clear"* — it seals and cannot open, and opening
       * needs the account's viewing key, which no invitee ever holds.
       *
       * **WHY PUTTING THEM HERE IS SAFE, IN ONE SENTENCE EACH.** Both are
       * public by construction — a contract address is on a chain and an inbox
       * key is a public key — so nothing secret has been added to this
       * envelope. And they are sealed anyway, under a key derived from the raw
       * token, so the only party who can read them is the one already holding
       * the capability they belong to.
       *
       * `companyAddress` is null when this company has no address a chain
       * assigned. That is `C140`'s gate, unchanged and in the same words: the
       * refusal arrives on the invitee's screen rather than stopping a hire.
       */
      offer: seal(canonical({
        company: this.accounts.open(accountId, viewingKey).name,
        companyAddress: companyAddressForOffer(this.store, accountId),
        inboxPublicKey: this.accounts.require(accountId).inboxPublicKey,
        name: spec.name, title: spec.title, email: spec.email,
        asset: spec.asset, baseAmount: spec.baseAmount,
        startDate: employee.startDate,
      }), offerKeyOf(raw)),
    };
    this.store.putInvite(invite);

    /*
     * DELIVERED, NOT RETURNED. A-10.
     *
     * The token does not come back to the caller, so an operator cannot redeem
     * it. Everything else in this method is unchanged; this one line is what
     * makes "the payee's key comes from the payee" true rather than claimed.
     */
    /*
     * **NOTHING IS DELIVERED TO NOBODY.** `X8`.
     *
     * A null email reaches here from `addSelfAsPayee` alone, where the token is
     * redeemed inside the same call and never leaves the method. Calling the
     * delivery with a null address would put a raw invite token into the
     * delivery port's memory — beside no name and no mailbox — for a
     * conversation that has no second party. `C8`'s retention, for nothing.
     */
    if (spec.email !== null) {
      this.delivery.send({ email: spec.email, name: spec.name }, raw, accountId);
    }
    /*
     * `delivered` is false today and that is not a detail. Until a mailer
     * exists, **nobody can complete onboarding**: the token reaches no one, the
     * roster entry stays `pending`, and a run refuses to build while anybody is
     * pending. An operator is entitled to be told that at the moment they hire
     * somebody rather than on payday. `A-12`.
     */
    return { employee, sentTo: spec.email, delivered: this.delivery.delivers, raw };
  }

  /**
   * A MEMBER ADDS THEIR OWN PAYEE ADDRESS. Decided 17 Aug — and it is what the
   * "sole member" exception was badly approximating.
   *
   * A founder creating a company and adding themselves, or a vendor who has just
   * incorporated, is **not an employee being invited**. There is no third party,
   * no token, nothing to deliver and nobody to impersonate: the person setting
   * the address is the person the money is for, by construction.
   *
   * Treating it as an invitation is what produced an exception that had to ask
   * "is there anybody to defraud" — a question no count can answer honestly, and
   * the one this codebase answered with a list of signer seats that cannot see
   * an employee at all.
   *
   * **So there is no exception anywhere in the invite path.** The person who
   * raises an employee invite may never be the person who redeems it, without
   * qualification.
   */
  addSelfAsPayee(
    accountId: string, userId: string,
    /**
     * **`email` IS NOT TAKEN FROM HERE.** It is read off the caller's own
     * sign-in — see below. The type keeps the field because `HireSpec` is
     * shared, and it is overwritten rather than trusted.
     */
    spec: HireSpec, viewingKey: Hex,
    /**
     * `Payee` since `S12`. A member adding their own address, or a company
     * recording its own, hands over whatever their wallet produced, and the
     * string says which kind it is. `C250`.
     */
    handover: { wrappingPublicKey: Hex; address: Payee },
  ): RosterEmployee {
    const account = this.accounts.require(accountId);
    if (!account.memberUserIds.includes(userId)) {
      throw new Error(
        'only somebody already on this account can add themselves as a payee. '
        + 'Anybody else is an employee, and an employee is invited');
    }

    /*
     * "SELF" IS ENFORCED HERE, NOT ASSERTED IN THE METHOD NAME. `C24`.
     *
     * The first version took the payee's name, email, salary AND address as
     * request-body fields and checked exactly one thing: that the caller was on
     * the account. It then admitted under `self`, which skips every refusal
     * `admit` has — the raiser-is-not-redeemer negative and the `A-11` email
     * positive both. **So one authenticated call produced an active, immediately
     * payable roster entry bearing somebody else's name and the CALLER's
     * address, repeatably, at any amount.** Reproduced by audit the turn it
     * shipped: three fabricated payees, all paying one address, suite green.
     *
     * That is `C21` at a strictly lower price — no mailbox, no registration, no
     * token, no second sign-in — reached through the flow the register cites as
     * the safe alternative to `C21`. **A door built to remove an exception
     * became the exception with a route in front of it.**
     *
     * Two things hold it now. **The record is about the CALLER**, because
     * everything identifying on it is read off their own sign-in and never off
     * the body — the email when they have one (`X8`: `null` when they do not),
     * and the sign-in itself, which lands on the entry as `handedOverBy`. And
     * one payable entry per person: a second call cannot mint a second payee
     * under the same identity, whichever of the two identifies them.
     */
    const me = this.store.getUser(userId);
    if (!me) throw new Error('that sign-in no longer exists');
    /*
     * **A WALLET SIGN-IN CAN BE MADE PAYABLE, AND THIS IS WHERE IT CHANGED.**
     * `X8` §3, `C153`. It used to refuse here, and the refusal was right at the
     * time: this route's whole defence is that the record is unavoidably about
     * the CALLER, and until `X8` the only thing making it so was an email read
     * off their sign-in. A wallet sign-in has none — **and since `PI4b` there
     * is no other kind of sign-in, so `me.email` is null on every caller that
     * reaches this door.**
     *
     * **THE EMPTY STRING IS STILL REFUSED, AND IT IS NOT REFUSED HERE — THERE
     * IS NOWHERE LEFT TO WRITE ONE.** `X7` pinned a test saying a blank inverts
     * the cap: an empty email compares equal to another empty one, so two
     * people read as one person and one person reads as somebody else. The fix
     * is not a check, it is the TYPE: `RosterEmployee.email` is
     * `string | null`, `null` means *nothing ever asked them for one*, and
     * `admit`'s cap never compares two absences.
     *
     * **SO WHAT IDENTIFIES THE PERSON INSTEAD, AND WHY IT CANNOT BE TWO
     * PEOPLE.** The user's own row. A `User` is created once per credential.
     * This used to name two halves — `register` refusing a second row for one
     * email address, and a wallet sign-in finding its row by
     * `getUserByWalletKey`. **`PI4b` deleted the first half along with the
     * password, and the surviving half is the stronger one:**
     * `getUserByWalletKey` is `sha256` of the subwallet address the signature
     * was verified against, and **only somebody holding that subwallet's
     * spending key can produce a signature that resolves to that row**, so one
     * id is never two people. The email half rested on a uniqueness check; this
     * one rests on a key nobody else has.
     *
     * **AND THE HONEST OTHER DIRECTION: one person may be two ids.** Two
     * subwallets are two rows, and an email account beside a wallet account is
     * two more. `docs/scope-payroll-identity.md` §2 is explicit that the slots
     * *do not make a person two people* — and equally explicit that separation
     * hides employers from each other and from the chain and **has never hidden
     * anything from us**. What the cap can see is the identity payroll was
     * given; it cannot see across two of them, and nothing here may be
     * described as though it could.
     */
    /*
     * The one-entry-per-person cap USED TO BE HERE and is now in `admit`, where
     * both doors pass through it. It was on this door only, and `admit` — the
     * step that actually makes somebody payable — never consulted it, so the
     * ordinary invite path reached the same outcome with the cap skipped. `C26`.
     */
    const { employee, raw } = this.raise(
      /* The email is the caller's own, whatever the body said — and `null`
       * when they signed in with their wallet, which is a fact about them and
       * not a blank standing in for one (`X8`). */
      accountId, { ...spec, email: me.email }, viewingKey, userId);
    /*
     * The token never leaves this method. It exists because the roster entry and
     * the drop box are built by the same code either way; what is different is
     * that nobody is being asked to prove anything, because nobody else is
     * involved.
     */
    /*
     * **THIS DOOR SEALS ON OUR SIDE, AND THAT IS NOT `C160` RETURNING.** `X11`
     * §7.
     *
     * `C160` is about an address travelling to us in a request body. Here there
     * is no request carrying one: the address arrived inside a **signed
     * disclosure** which `payeeFromWallet` verified at the route, because the
     * value is being written onto a company's roster by somebody who is already
     * on it, and *a check made by the thing being persuaded is not a check*.
     * That verification needs the plaintext by construction. So the plaintext
     * is here for one call either way, and sealing it here is what makes the
     * two doors leave the store in the same shape.
     */
    this.acceptInvite(
      raw,
      sealHandover(
        {
          wrappingPublicKey: handover.wrappingPublicKey,
          address: handover.address.bech32,
          /*
           * **NO CODE, BECAUSE THERE IS NOBODY TO COMPARE ONE WITH.** `X12` §2.
           * The comparison exists so an admin can check that the address which
           * arrived is the one the payee's wallet showed. Here the caller IS
           * the payee, in one call, with no page in between and no second
           * party — so there was never a comparison to make, and a code minted
           * on this side would be this service confirming itself.
           */
          confirmation: null,
        },
        this.accounts.require(accountId).inboxPublicKey),
      userId);
    /*
     * THE SAME `admit`, WITH THE SAME CHECKS. No bypass — that bypass was `C24`.
     *
     * What is left of this method is convenience, not authority: it walks the
     * ordinary three steps in one call, for the one case where the person
     * redeeming is the session raising. It passes every refusal `admit` has,
     * including the positive one, because the email on the record is the
     * caller's own sign-in.
     *
     * **Kept rather than deleted** because deleting it would make the mailer a
     * hard dependency for a founder getting on their own payroll — the token
     * would have to travel to an inbox to come straight back to the same person.
     */
    return this.admit(employee.id, viewingKey, userId);
  }

  /**
   * The employee's own device hands over what it made. A-2.
   *
   * NO VIEWING KEY IS REQUIRED, and that is the point: an employee must never
   * hold the company's key. So they cannot write into the sealed roster, and
   * what they hand over goes into the account's DROP BOX — sealed to a public
   * key whose secret only a viewing-key holder can derive. `admit` folds it in.
   *
   * **The address is produced here or not at all**, on the invite path — and
   * `addSelfAsPayee` is the one other place a payee address enters, where the
   * caller and the payee are the same person by construction rather than by
   * assertion (`C24`). Nowhere can an operator supply an address for SOMEBODY
   * ELSE, which is what `V-78` option 3 asks for.
   *
   * They stay `pending` until an admin admits them. That step is not ceremony —
   * it is `C9`: an address on file is not the same as somebody who can reach
   * what is sent to it, and a payment settles irreversibly the moment it lands.
   */
  /*
   * **X11 §7 — THERE IS NOWHERE HERE TO PUT A PLAIN ADDRESS, AND THAT IS THE
   * WHOLE OF `C160`.**
   *
   * This took `{ wrappingPublicKey, address: PayeeAddress }` and sealed it. The
   * route above it parsed a bech32 STRING off a request body to build that
   * `PayeeAddress`, **so the plaintext existed in our process and in anything
   * that ever logged a body.** `docs/scope-invitations.md` §5 decided the
   * opposite on 22 Aug and this is that decision arriving.
   *
   * The parameter is now a blob **this service cannot open**. Not *does not*:
   * cannot — it is sealed to the account's inbox public key, and the secret for
   * that is derived from the account's viewing key, which reaches this method
   * on no path. `invite-handover.ts` owns the shape; `admit` is where it is
   * opened, by somebody holding the key.
   *
   * **The rule is expressed as a missing parameter**, the same way
   * `companyForSession` has nowhere to put a claimed company. A route cannot
   * forget a rule it has no argument for, and `scripts/mutate-invitations.mjs`
   * puts the plain address back at the route — which is the only place it could
   * be added — and names the test that dies.
   */
  /**
   * **THE ONE PLACE AN INVITATION IS JUDGED READABLE, AND IT IS WHERE THE OFFER
   * IS READ RATHER THAN WHERE IT IS SHOWN.** `X12` §3,
   * `docs/scope-invitations.md` §8.
   *
   * §8: *"Expiry and revocation must be enforced where the offer is READ, not
   * only where it is shown, or a stale link still opens an offer."* A screen
   * that hides an expired offer is a screen; the door behind it still answers
   * anybody who calls it with a token, and the token is the whole capability.
   *
   * **BOTH DOORS COME THROUGH HERE**, which is the point of it being a method
   * rather than two copies of four lines: reading the offer and spending it are
   * the same judgement one step apart, and a version of this that lived in
   * `offerFor` alone would refuse to SHOW an expired offer to the one person
   * entitled to see it while still letting anybody ACCEPT it.
   *
   * **IT FAILS CLOSED ON A MISSING DEADLINE.** An invitation with no `expiresAt`
   * predates the field and cannot acquire one — no migration can invent when an
   * offer was meant to lapse — and §9 refuses an invitation without an expiry
   * by name. So it is refused, with the exit said out loud, in the shape `C28`
   * argues for: not knowing is precisely when to refuse.
   */
  private readableInvite(token: string): Invite {
    const invite = this.store.getInvite(token);
    if (!invite) throw new Error('invite not found');
    if (invite.kind !== 'employee') throw new Error('that is not an employee invite');
    if (invite.acceptedAt) throw new Error('invite already used');
    if (invite.revokedAt) {
      throw new Error(
        'this invitation has been withdrawn by the company that sent it, so there is no '
        + 'offer here any more. Nothing you do with this link can change anything. If you '
        + 'were expecting to be hired, ask whoever sent it to you.');
    }
    if (!invite.expiresAt || Date.parse(invite.expiresAt) <= Date.now()) {
      throw new Error(
        'this invitation has expired, so the offer it carried can no longer be opened or '
        + 'accepted. Nothing has been sent and nothing has changed. Ask whoever invited you '
        + 'to send a new invitation — the same link cannot be re-opened, by them or by us.');
    }
    return invite;
  }

  /**
   * **AN ADMIN TAKES AN INVITATION BACK.** `X12` §3,
   * `docs/scope-invitations.md` §8.
   *
   * A hire falls through after the link has been sent and until now there was
   * nothing to do about it: the link kept working and whoever held it could
   * still set the address a salary is paid to. This is addressed by the PERSON
   * rather than by the token, because the admin does not hold the token —
   * `invite()` hands it back once, to the browser that raised it, and no route
   * gives it out again (`X11` §1).
   *
   * **IT DOES ONE THING.** The roster entry is not touched: withdrawing the
   * PERSON is `setStatus`, it is a separate control on the same row, and the
   * lifecycle §8 describes is explicitly not this round's. What this does is
   * make the link dead, everywhere it is read.
   */
  revokeInvite(employeeId: string): Invite {
    const rec = this.store.getEmployee(employeeId);
    if (!rec) throw new Error('employee not found');
    const invite = this.store.listInvites(rec.accountId)
      .find(i => i.subjectId === employeeId);
    if (!invite) {
      throw new Error(
        `there is no invitation on record for ${employeeId}, so there is no link to take `
        + 'back. Somebody added as a payee from their own sign-in has no invitation.');
    }
    /* Already taken back is not a failure — an admin pressing twice, or two
     * admins deciding the same thing, must not read as an error. The FIRST
     * moment is what is recorded. */
    if (invite.revokedAt) return invite;
    const revoked: Invite = { ...invite, revokedAt: new Date().toISOString() };
    this.store.putInvite(revoked);
    return revoked;
  }

  acceptInvite(
    token: string,
    /** Sealed on the invitee's own device. `invite-handover.ts`. */
    handover: SealedHandover,
    /** Who is redeeming it. The route is authenticated so this is never guessed. A-10. */
    byUserId: string | null = null,
  ): SealedEmployee {
    /* X12 §3 — expired and revoked are refused HERE, not only on the screen
     * that showed the offer. A stale link that can still be spent is a stale
     * link that works. */
    const invite = this.readableInvite(token);
    /*
     * **WHAT CAN BE CHECKED HERE IS THAT SOMETHING WAS SEALED, AND NOTHING
     * MORE.** The contents are checked where they are opened, by `admit`,
     * because that is the only place with the key. An empty box is still
     * refused, so an accept that hands over nothing does not spend the
     * invitation.
     */
    if (!handover || !handover.ephemeral || !handover.body) {
      throw new Error(
        'an address is required, and it has to come from your own device or wallet. '
        + 'Nobody can supply it on your behalf');
    }

    const employee = this.store.getEmployee(invite.subjectId!);
    if (!employee) throw new Error('employee not found');

    /*
     * **NOTHING IS REFUSED HERE FOR A REUSED SUBWALLET.** `C155`, `C131`.
     *
     * This read `if (byUserId) refuseReusedSubwallet(this.store, byUserId,
     * employee.accountId)`. It was the moment a person's wallet became the
     * thing a company pays, and it is exactly the case the decision of 22 Aug
     * was made about: **a vendor paid for several projects wants one address**,
     * so their accountant sees one stream. It could only ever have fired for
     * somebody who also held a seat, which is not most people, and a warning
     * that fires for some is worse than none.
     */

    const account = this.accounts.require(employee.accountId);
    this.store.putEmployee({
      ...employee,
      /*
       * EVERYTHING goes in the box, including the wrapping key that used to sit
       * outside the envelope. One handover, one place, opened once — rather than
       * half of it applied by somebody holding no key and half of it waiting.
       */
      /*
       * **TWO ENVELOPES, ONE KEY, AND THE OUTER ONE IS OURS.** `X11` §7.
       *
       * The inner envelope is the invitee's and we cannot open it. `byUserId`
       * cannot go inside it — the invitee's browser would then be writing the
       * only evidence of who redeemed the invitation, and `admit` reads that
       * field as evidence. So the service seals its own envelope around theirs.
       *
       * **SEALED WITH THE HANDOVER, not left beside it.** Who handed over an
       * address is part of the record of where somebody's money goes, and it is
       * exactly as private as the rest of it — which is why this is a nesting
       * rather than a second column. Both open with the same inbox secret, so
       * `admit` is one key and two `openFromInbox` calls.
       */
      inbox: sealToInbox(
        { byUserId, handover },
        account.inboxPublicKey),
    });

    invite.acceptedAt = new Date().toISOString();
    /*
     * THE OFFER COPY GOES WHEN THE INVITE IS SPENT FOR GOOD, AND THAT IS
     * `admit`, NOT HERE. Moved 17 Aug, found by audit.
     *
     * It existed to be READ before accepting, so dropping it on accept looked
     * like hygiene — one standing copy of a salary rather than two, which is
     * `S-9`'s shape. But a handover can be REFUSED, and the refusal PUTS THE
     * INVITATION BACK so the person can hand over again from the right
     * sign-in. Dropping the offer here made that retry a blank screen: the
     * invite reopens and `offerFor` throws for the rest of its life, because
     * only the holder of the raw token could re-seal it and we do not hold it.
     * **A put-back that restores half of what it took is `C17`'s shape again.**
     */
    this.store.putInvite(invite);
    return this.store.getEmployee(employee.id)!;
  }

  /**
   * WHAT THE PERSON HOLDING THIS TOKEN IS BEING OFFERED. A-7.
   *
   * **No viewing key, and none is possible** — an invitee must never hold the
   * company's. The offer is sealed under a key derived from the raw token, so
   * holding the token is what opens it. **The server cannot**: it stores only
   * the hash, and the offer key is domain-separated from it.
   *
   * This exists because the order was wrong. An invitee was asked to hand over
   * the address their salary would be paid to **before being shown what the
   * salary was, the title, or who was offering it.** You should see what you are
   * accepting before you accept it — and the person best placed to notice that a
   * hire is wrong is the person it is about.
   */
  offerFor(token: string): {
    company: string;
    /** X11 §0. Null when no chain has given this company an address. */
    companyAddress: string | null;
    /** X11 §7. What the invitee's own browser seals the handover to. */
    inboxPublicKey: Hex;
    name: string; title: string; email: string;
    asset: AssetId; baseAmount: bigint; startDate: string;
    /**
     * X12 §3. **Beside the sealed offer rather than inside it**, because it was
     * not known when the offer was sealed in the sense that matters: it is the
     * service's own fact about this invitation, and the service is what
     * enforces it. The invitee is shown it so a deadline is something they can
     * act on rather than something that happens to them.
     */
    expiresAt: string;
  } {
    const invite = this.readableInvite(token);
    if (!invite.offer) throw new Error('this invite carries no offer to show');
    return {
      ...parseCanonical<{
        company: string; companyAddress: string | null; inboxPublicKey: Hex;
        name: string; title: string; email: string;
        asset: AssetId; baseAmount: bigint; startDate: string;
      }>(unseal(invite.offer, offerKeyOf(token))),
      expiresAt: invite.expiresAt!,
    };
  }

  /**
   * An admin opens the drop box and folds the handover into the sealed roster.
   *
   * The step the employee could not do for themselves, and the one that makes
   * them PAYABLE. **Emptying the box matters as much as writing the roster:**
   * leaving the copy would be two records of where somebody's money goes, and
   * two records of one thing are two records that can disagree.
   */
  admit(
    employeeId: string, viewingKey: Hex,
    /** Which admin is doing this. Recorded on the roster entry. A-10. */
    byUserId: string | null = null,
  ): RosterEmployee {
    const rec = this.store.getEmployee(employeeId);
    if (!rec) throw new Error('employee not found');
    if (!rec.inbox) {
      throw new Error(
        rec.status === 'active'
          ? `${employeeId} has already been admitted`
          : `${employeeId} has not handed anything over yet, so there is nothing to admit`);
    }

    /*
     * **THE OUTER ENVELOPE IS OURS AND THE INNER ONE IS THE INVITEE'S.** `X11`
     * §7. One key opens both; `openHandover` checks the inner shape rather than
     * casting it, because what comes out of an envelope is JSON.
     */
    const box = openFromInbox<{
      byUserId?: string | null; handover: SealedHandover;
    }>(rec.inbox, rec.accountId, viewingKey);
    const handover = openHandover(box.handover, rec.accountId, viewingKey);

    /*
     * THE PERSON WHO RAISED THE INVITE MAY NEVER BE THE PERSON WHO REDEEMED IT.
     * A-10, with no exception — decided 17 Aug.
     *
     * The first version of this had one, for "an account with a single member,
     * which has nobody to defraud". Two things were wrong with it. It measured
     * `memberUserIds`, which is **active signers carrying a user id** — the
     * server gives one to the first signer and null to the rest, so a
     * three-signer company read as sole-member and **so did a company with one
     * admin and two hundred employees.** The number deciding "is there anybody
     * to defraud" could not see an employee, and an employee is the only person
     * this protects. And it was wrong in principle even measured correctly: a
     * founder who invites a real employee and redeems it themselves has
     * defrauded that employee whatever the member count says.
     *
     * **The case it was groping for is not an invitation at all.** A founder
     * adding themselves, or a vendor who has just incorporated, is
     * `addSelfAsPayee` — no token, no third party, nobody to impersonate. Two
     * flows, not one flow with a hole in it.
     *
     * AND IT FAILS CLOSED. The first version disabled itself when it could not
     * establish who redeemed the invite — a missing `createdBy`, a missing
     * `acceptedBy`, a missing invite record — which is `C16`'s lesson from the
     * same day, one file over: **a guard whose failure mode is to disable itself
     * is not a guard.** Not knowing who set the address of record is precisely
     * when to refuse.
     */
    const invite = this.store.listInvites(rec.accountId)
      .find(i => i.subjectId === employeeId);
    /*
     * ONLY the sealed copy. There was a fallback to a plaintext `acceptedBy` on
     * the invite; that field was a leak and is gone, and a fallback to a value
     * that no longer exists is a guard quietly weakening itself.
     */
    const acceptedBy = box.byUserId ?? null;

    /*
     * EVERY REFUSAL PUTS THE HANDOVER BACK. `C28`, found by audit 17 Aug, and
     * it is the fourth time this shape has been paid for.
     *
     * `C23` wired the put-back to ONE of this method's five refusals — the
     * email mismatch — because that was the one being fixed. The other four
     * left the drop box full and the invite spent, and **there is no route that
     * re-opens an invite or empties a box.** A run refuses to build while
     * anybody is `pending`, so any one of them froze the WHOLE account's
     * payroll behind one person, permanently.
     *
     * Refusing and stranding are different things. This method's job is to
     * refuse; leaving the person unrecoverable is not part of it.
     */
    const putBack = () => {
      this.store.putEmployee({ ...rec, inbox: null });
      if (invite) this.store.putInvite({ ...invite, acceptedAt: undefined });
    };
    {
      if (!invite) {
        putBack();
        throw new Error(
          `there is no invite on record for ${employeeId}, so there is no way to tell who set `
          + 'this address. It has been refused and the drop box emptied. Re-invite them rather '
          + 'than admitting it.');
      }
      /*
       * **X12 §3 — A WITHDRAWN INVITATION CANNOT BE ADMITTED, AND THIS IS THE
       * THIRD PLACE IT IS ENFORCED ON PURPOSE.** `docs/scope-invitations.md`
       * §8.
       *
       * §8 says expiry and revocation are enforced where the offer is READ. The
       * two reading doors are `offerFor` and `acceptInvite`, and both go
       * through `readableInvite`. **This is neither of them, and it is where
       * the money is**: a hire falls through, the admin takes the link back —
       * and somebody who had already accepted, minutes earlier, is sitting in
       * the drop box waiting to be made payable. Admitting them is admitting a
       * hire that was called off.
       *
       * It refuses in the shape every other refusal here does — the box is
       * emptied and the invitation put back — so nobody is stranded `pending`
       * behind a run. The invitation stays revoked, so the put-back cannot be
       * spent: the exit is to withdraw the person, which is the row's own
       * control.
       */
      if (typeof invite.revokedAt === 'string') {
        putBack();
        throw new Error(
          'this invitation was taken back before this was admitted, so admitting it would '
          + 'put somebody on the payroll whose hire was called off. It has been refused and '
          + 'the drop box emptied. Withdraw this person, and invite them again if the hire '
          + 'is back on.');
      }
      if (!acceptedBy) {
        putBack();
        throw new Error(
          'this handover does not record who redeemed it, so it is not evidence of anything. It '
          + 'has been refused and the invitation put back — they can hand over again from a '
          + 'signed-in device.');
      }
      /*
       * AN INVITE RAISED BEFORE THE PRODUCT RECORDED WHO RAISED IT, NAMED AS
       * ITS OWN STATE. `C28`.
       *
       * This used to share a message with "we do not know who redeemed it",
       * which is a different situation with a different remedy — and the
       * remedy it offered, *"re-invite them"*, mints a SECOND pending entry
       * beside the first and freezes the account twice. `createdBy` arrived
       * with `A-10`; every invite written before it is missing this field
       * permanently and no migration can invent it. So it is refused, and the
       * only exit that actually works is said out loud.
       */
      if (!invite.createdBy) {
        putBack();
        throw new Error(
          'this invitation was raised before the product recorded who raised it, so nothing '
          + 'here says the address was set by the payee rather than by whoever invited them. '
          + 'It cannot be admitted, and re-inviting alone will not clear it — mark this person '
          + 'a leaver first, then invite them again.');
      }
      /*
       * SAME PERSON RAISED AND REDEEMED? RECORD IT. DO NOT REFUSE. 17 Aug.
       *
       * This used to throw. Removing it is deliberate and here is the whole
       * argument, because it reverses a decision made a few hours earlier.
       *
       * **It asks about the wrong person.** "Who raised this?" is a proxy. The
       * question that matters is "is the redeemer the payee?", and the check
       * below answers it directly: you must be signed in as the address on the
       * record. A founder inviting themselves passes that naturally, because
       * they ARE that address.
       *
       * **What the refusal bought:** an operator attacking somebody else had to
       * register a sockpuppet rather than redeem as themselves. One step. It
       * never stopped the attack — `C21` lets an operator type their own address
       * as the employee's either way, and the sockpuppet costs one free
       * registration.
       *
       * **What it cost:** a second flow, so a founder could get on their own
       * payroll. That flow became `C24` — an active, immediately payable entry
       * under anybody's name for the price of one POST, which is cheaper than
       * the attack this refusal was slowing down. **A guard whose price is a
       * parallel authorisation surface is not worth a speed bump**, and this
       * repo's history says authorisation complexity is where the money holes
       * live.
       *
       * The information is not lost, only the refusal: it lands on the roster
       * entry as `selfRaised`, where an admin reviewing can see it.
       */

      /*
       * **THE POSITIVE, AND `PI4c` DELETED THE ONE THAT USED TO BE HERE.**
       * `docs/how-money-can-be-lost.md` `C21`, `X12` §2.
       *
       * Everything above proves a NEGATIVE, or proves who was involved: an
       * invitation exists, it was not taken back, we know who raised it and who
       * redeemed it, and nobody on this account is already payable as this
       * person. **None of that says the address in the box is the payee's.**
       *
       * ── WHAT USED TO STAND HERE, AND WHY IT IS GONE ─────────────────────
       *
       * A comparison of the redeemer's sign-in email against the email on the
       * sealed roster entry, asking *is the redeemer the person the company
       * said it was hiring*. **The company said it in a form field.** The
       * operator types the email at hire time, the invitation is addressed to
       * that string, and the check compared against that same string — so an
       * operator hiring somebody controlled BOTH SIDES of the only positive
       * evidence in the flow. Name a mailbox you own, sign in there, redeem,
       * admit: every refusal passed. Reproduced end to end by audit. `C21`.
       *
       * **AND IT HAD STOPPED LETTING ANYBODY BE HIRED AT ALL.** `PI4b` deleted
       * the password, so a real invitee signs in with a wallet and a wallet
       * sign-in carries no email — which this comparison read as *there is
       * nothing to check them against* and refused. A check that refuses every
       * real person and passes the operator attacking them is not a weak
       * check; it is one pointing the wrong way.
       *
       * ── WHAT REPLACED IT ───────────────────────────────────────────────
       *
       * A positive the PAYEE produces, below: the code their own wallet showed
       * them for the address it was about to disclose, sealed inside the
       * handover, compared against the code computed here from the address
       * that actually arrived. **Nothing in it is a string an operator can
       * type.**
       */
      const person = this.open(rec, viewingKey);
      const redeemer = this.store.getUser(acceptedBy);
      if (!redeemer) {
        putBack();
        throw new Error(
          'the account that redeemed this invite no longer exists, so there is nothing left '
          + 'saying who set this address. It has been refused and the invitation put back.');
      }
      const same = (a: string) => a.trim().toLowerCase();

      /*
       * ONE PAYABLE ENTRY PER PERSON, CHECKED WHERE SOMEBODY BECOMES PAYABLE.
       * `C26`, found by audit 17 Aug — and it is the price the raiser refusal
       * had been quietly paying.
       *
       * This cap lived in `addSelfAsPayee` alone. `admit` never consulted it, so
       * once the raiser refusal was removed a member could raise an ordinary
       * employee invite carrying **their own sign-in email** under any name and
       * any salary, redeem it themselves, admit, and repeat — every refusal
       * passing, because the only positive asks whether the redeemer is the
       * email on the record and the record says the member. **Reproduced by the
       * auditor: three payees, one address, £27,000, suite green.**
       *
       * Here it covers both doors, because both come through `admit`.
       */
      /*
       * **X8 — WHAT THE CAP KEYS ON, AND WHY IT CANNOT BE TWO PEOPLE.**
       * `docs/NEXT.md` X8 §3, `C153`.
       *
       * It keyed on the email alone, which cannot serve somebody who has none —
       * and `X7` pinned a test saying the obvious repair, a blank, INVERTS it:
       * two absences compare equal, so every wallet-signed-in person on an
       * account would read as the same person, and none of them as themselves.
       *
       * **SO IT KEYS ON THE PERSON, AND A PERSON IS THE SIGN-IN THAT SET THE
       * ADDRESS.** `handedOverBy` is that sign-in, sealed onto the entry at
       * this very step, and it is the payee on both doors by construction: on
       * the self path the caller IS the payee, and on the invite path the
       * positive check below refuses a redeemer who is not the person the
       * company addressed.
       *
       * **WHY ONE ID IS NEVER TWO PEOPLE.** A `User` row is created once per
       * credential. This used to rest on two halves; `PI4b` deleted `register`
       * and with it the refusal of a second row for one email, **and the half
       * that remains is the one that never needed a check**: a wallet sign-in
       * resolves to its row by `sha256` of the address the signature was
       * verified against, which only the holder of that subwallet's spending
       * key can produce.
       *
       * **AND THE EMAIL IS STILL A KEY, FOR THE ROWS THAT PREDATE THE OTHER
       * ONE.** `handedOverBy` arrived with `A-10`; every entry admitted before
       * it carries `null` there for ever and no migration can invent one. The
       * two are not two spellings of one fact that could disagree — they are
       * two ways of RECOGNISING the same person, and either one matching is a
       * clash. **A cap that fires on more is never the failure; a cap that
       * fires on less is one person paid twice.** Both absences are guarded,
       * so no two nulls and no two blanks ever meet.
       */
      const isTheSamePerson = (p: RosterEmployee): boolean => (
        (p.handedOverBy !== null && p.handedOverBy === acceptedBy)
        || (p.email !== null && person.email !== null
          && same(p.email) === same(person.email)));

      const clash = this.listPeople(rec.accountId, viewingKey).find(p =>
        p.id !== employeeId && p.status === 'active' && isTheSamePerson(p));
      if (clash) {
        putBack();
        /*
         * **IT USED TO SAY *"change the address on that record"*, AND NOTHING
         * IN THIS PRODUCT CAN.** Found by `product-copy-auditor` on `S12`, by
         * reading every writer of a roster address rather than the message.
         *
         * `admit` is the only line that writes one, and it refuses an entry
         * that has already been admitted. `raise` writes `null`. `setStatus`
         * carries the existing value through. There is no service method, no
         * route and no field on any screen. **So the refusal named the one
         * thing an operator could not do, at the moment they were blocked.**
         *
         * What the product CAN do is the sentence below, and the control is
         * already labelled *Mark leaver* — because the clash filters on
         * `status === 'active'`, so a leaver frees the cap and the person can
         * be added again at their new address.
         *
         * **AND THAT IS THE TWO-FINGERPRINTS COST, SAID WHERE IT IS PAID.**
         * One person holds one address, so changing how somebody is paid is a
         * re-admission rather than an edit, and their payslips before and after
         * sit under two `addressFingerprint` values. `C250`, answered in
         * `a-payroll-run-is-always-private.test.ts` §5b.
         */
        throw new Error(
          `${person.email ?? 'the person who signed in to set this address'} is already `
          + 'payable on this account. One person gets one payable record, because two '
          + 'records is two salaries. To pay them at a different address, mark the existing '
          + 'record a leaver and add them again.');
      }

      /*
       * **X8 — A RECORD WITH NO EMAIL IS ONE THE PAYEE MADE FOR THEMSELVES, AND
       * ITS POSITIVE IS A DIFFERENT SENTENCE.**
       *
       * A record with no email was never addressed to anybody: the only door
       * that writes one is `addSelfAsPayee` — `invite` refuses a spec with no
       * email by name — where the person raising, the person redeeming and the
       * payee are one call. There is also no page in that flow, so there is no
       * code either, which is why the check below cannot serve it.
       *
       * **SO THE POSITIVE IS THAT THEY ARE ONE PERSON, CHECKED RATHER THAN
       * ASSUMED.** It fails closed for the same reason every other exit here
       * does: if the ids do not agree, nothing on this record says the address
       * was set by the payee rather than by whoever raised it, and that is
       * precisely when to refuse. `selfRaised` records the same fact for an
       * admin to see; here it is load-bearing.
       *
       * **AND IT IS NOT THE DELETED COMPARISON WEARING A HAT.** `PI4c`. It
       * reads no email on either side. It compares two SIGN-INS this service
       * watched arrive, neither of which an operator can name in a form field
       * — which is the whole of what was wrong with the one that went.
       */
      if (person.email === null && invite.createdBy !== acceptedBy) {
        putBack();
        throw new Error(
          'this record is not addressed to an email address, so the only thing that can '
          + 'say whose it is, is that one person raised it and redeemed it — and two '
          + 'different sign-ins did. It has been refused and the invitation put back.');
      }

      /*
       * **THE CODE THE PAYEE'S OWN WALLET PRODUCED, ENFORCED WHERE THE ROSTER
       * IS WRITTEN.** `PI4c`, `C21`, `X12` §2, `docs/scope-invitations.md` §5.
       *
       * The invitee's wallet shows a code for the address it is about to
       * disclose; they paste it into the join screen; it travels SEALED inside
       * the handover, because a fingerprint is a hundred bits that identify one
       * address and so is a standing handle on where somebody is paid. Here the
       * same code is computed from the address that ACTUALLY ARRIVED. **Two
       * codes, both derived from an address and from nothing else.**
       *
       * **WHY THIS IS NOT `C160` RETURNING THROUGH A SIDE DOOR.** §5's rule is
       * that the fingerprint an ADMIN reads is computed on the admin's machine,
       * and it still is — `src/web/accepted-address.ts`, against ciphertext
       * from a route that has nowhere to put a key. This is not that screen. It
       * is `admit`, which has held the opened handover and rebuilt the address
       * through the decode below for rounds, because it is the step that writes
       * the address onto the roster. Hashing a value already in this scope
       * gives this service nothing it did not have on the line below.
       *
       * **WHAT IT MAKES IMPOSSIBLE.** A page that took the person's approval
       * and sealed somebody ELSE'S address: every other check passes, the
       * envelope is well formed, the roster entry is right in every field — and
       * the code cannot be recomputed without the wallet, so it does not match
       * and nobody becomes payable. Before `PI4c` that mismatch reached a
       * screen and an admin who clicked admit anyway was obeyed.
       *
       * **WHAT IT DOES NOT PROVE, UNCHANGED AND STILL `C21`'s:** somebody
       * accepting their own invitation pastes their own matching code. The
       * codes agreeing means the address that arrived is the one the wallet
       * showed. It has never meant the right person was invited.
       *
       * **`null` IS NOT A MISMATCH.** `addSelfAsPayee` walks this shape with no
       * page, no second party and nothing to confirm, and a drop box sealed
       * before the field existed carries none either. A blank standing in for a
       * code would be `X8`'s own lesson — two absences that compare equal — so
       * the screen says *no code was given* and the admin confirms another way.
       * **This is absence, not disagreement**, and it is the one door in this
       * product that can produce it.
       */
      if (handover.confirmation !== null) {
        /* A string that is not address-shaped cannot have a code, and refusing
         * it HERE is recoverable where `payeeOf()` further down would throw
         * past the put-back and strand the drop box. `C28`. */
        let ours: string | null = null;
        try {
          ours = addressFingerprint(handover.address);
        } catch (e) {
          if (!(e instanceof FingerprintError)) throw e;
        }
        if (ours === null || handover.confirmation !== ours) {
          putBack();
          throw new Error(
            'the code this person read off their own wallet is not the code of the address '
            + 'that arrived, so the address in this handover is not the one their wallet '
            + 'showed them. It has been refused and the invitation put back — ask them to '
            + 'accept again, and if it does not match a second time the page they accepted '
            + 'on is not ours.');
        }
      }
    }

    /*
     * REBUILT FROM ITS OWN STRING RATHER THAN TRUSTED AS AN OBJECT.
     *
     * What comes out of the box is JSON — a shape that looks like an address,
     * not an address. Re-parsing means the value the roster holds came out of a
     * decode like every other one, so a handover carrying two halves that were
     * never one address cannot get in by being well formed. A-1, `C7`.
     *
     * **`payeeOf` SINCE `S12`, AND IT IS THE SAME DECODE.** `C250`, `V-105`.
     * The kind is READ off the string the wallet produced rather than asked
     * for, so this door admits a public address without anybody choosing
     * anything. Every check `payeeAddress` made is still made: the platform's
     * Bech32m checksum, the address type, and the network. What changed is that
     * two types are payees instead of one, and a third is still refused naming
     * both.
     *
     * **THE EMPLOYEE IS NOT EXPOSED BY THIS DOOR OPENING.** `payrollPayee`
     * refuses a public payee where a run is drawn and where its payment facts
     * are built, so being on the roster is not being payable from a payroll.
     */
    const address = payeeOf(handover.address, this.network);

    const person = this.open(rec, viewingKey);
    /*
     * The roster is filled and the box emptied in ONE write. It was two, and a
     * crash between them left an active roster entry and a full drop box —
     * two records of where somebody's money goes, which is what the box exists
     * to avoid rather than create. Found by audit.
     */
    this.putPerson(
      {
        ...person,
        wrappingPublicKey: handover.wrappingPublicKey,
        status: 'active',
        address,
        handedOverBy: acceptedBy,
        admittedBy: byUserId,
        admittedAt: new Date().toISOString(),
        /* Raised and redeemed by one person. Visible rather than refused. */
        selfRaised: Boolean(acceptedBy && invite && acceptedBy === invite.createdBy),
      },
      viewingKey, null);
    /*
     * AND THE OFFER COPY GOES HERE, on the write that spends the invite for
     * good. Until this line the invitation is still put-backable, so the copy
     * the invitee reads before accepting has to survive a refusal — see
     * `acceptInvite`. After it there is nothing left to retry and a second
     * standing copy of a salary is just a second copy.
     */
    if (invite.offer) this.store.putInvite({ ...invite, offer: null });
    /* And the delivery drops what it was still holding. `C30`. **Nothing was
     * ever delivered for a record with no email** (`raise` does not call the
     * port at all), so there is nothing to forget and nothing to look up by a
     * value that is not there. */
    if (person.email !== null) this.delivery.forget?.(person.email);
    return this.person(employeeId, viewingKey)!;
  }

  /**
   * Seeding and tests only. Generates the employee's key server side, which is
   * exactly what `invite()` exists to avoid.
   *
   * **IT SAID "not reachable from the API" AND THAT WAS FALSE.** `POST
   * /api/demo/seed` is authenticated and nothing more, and `seedDemo` calls this
   * eight times. So the product can mint roster entries that are `active`, carry
   * a well-formed address, and pass every check in `paymentFactsFor` — while
   * **nobody on earth holds the spending key for them.** The only thing between
   * that and lost money today is that the server still runs `SimulatedLedger`.
   * `C13`, and it needs to be refusable by construction rather than by a comment.
   */
  hireDirect(accountId: string, spec: HireSpec, viewingKey: Hex): { employee: RosterEmployee; secret: EmployeeSecret } {
    /*
     * **THE SEED WALKS THE INVITE PATH, SO IT NEEDS WHAT THE INVITE PATH
     * NEEDS.** `X8`.
     *
     * `HireSpec.email` became nullable for `addSelfAsPayee`, and this helper
     * builds the seeded person a SIGN-IN of their own — which is an email
     * account, because `admit` checks a redeemer against the email the company
     * addressed. A null here would put an empty string in a user row and hand
     * every other blank row the same identity, which is the one thing `X8` is
     * written against. Refused by name rather than coerced.
     */
    if (spec.email === null || spec.email.trim() === '') {
      throw new Error(
        'a seeded employee is given a sign-in of their own, so this helper needs an email '
        + 'address for them. Somebody with none adds themselves as a payee from their own '
        + 'sign-in and is not seeded');
    }
    const email = spec.email;
    const { employee, raw } = this.raise(accountId, spec, viewingKey, 'usr_seed_operator');
    /*
     * **THE SEEDED PERSON GETS A WALLET, AND THEIR PAYSLIP KEY IS DERIVED FROM
     * IT.** `PI2b`, `C135`.
     *
     * This line used to be `newWrappingKeypair()` — thirty-two random bytes,
     * handed back once, recomputable by nobody. **The seed is the only place in
     * this product that produces an employee's payslip key**, and it now
     * produces one the person can work out again on any device from the words
     * alone. `payslip-key.ts` argues the derivation; this is its one caller in
     * product code.
     *
     * **THE DISHONESTY OF THE SEED IS UNCHANGED AND IS NOT THIS ROUND'S.** The
     * words are minted HERE, on the employer's server, so the employer holds
     * them — which is exactly what `invite()` exists to prevent and what
     * `C13` is about. A real employee's wallet is theirs and its words never
     * reach us; only `wrappingPublicKey` does. What the seed buys is that the
     * whole flow can be walked without eight browsers.
     */
    const company = this.store.getAccount(accountId)?.contractAddress;
    if (!company) {
      /*
       * REFUSED BY NAME RATHER THAN FALLING BACK TO A RANDOM KEY. A silent
       * fallback would put the minted key back for exactly the accounts the
       * derivation cannot serve, and nothing would say so.
       */
      throw new Error(
        'this company has no address, so a payslip key cannot be derived for anybody on '
        + 'it — and one will not be invented instead.');
    }
    const words = newWords();
    const wk = payslipKeypairForWallet(words, company, SEED_WALLET_ORIGIN);
    /*
     * Both halves of the real flow, not a shortcut past it. A seed helper that
     * skipped `admit` would produce roster entries no real onboarding can
     * produce, and every test built on it would be testing a state the product
     * cannot reach.
     */
    /*
     * The seed gives the employee a sign-in of their own, because the real path
     * requires one: `admit` checks that whoever redeemed the invite is signed in
     * as the person the company said it was hiring (A-11). A seed that skipped
     * that would build roster entries the product cannot produce, and every test
     * standing on it would be testing a state that does not exist.
     */
    const seedUser: User = {
      /*
       * A FRESH ID, NOT ONE BUILT FROM THE EMPLOYEE'S. Found by audit, 17 Aug.
       *
       * It was `usr_seed_<employeeId>`, and the employees table carries
       * `accountId` in the clear by design — so `users` plus a substring gave
       * "this named person is paid by this company" with **no join at all.**
       * That is the mapping `Invite.acceptedBy` was deleted the same turn to
       * prevent, reintroduced ten lines away by the seed. `C22`.
       */
      id: 'usr_' + nanoid(12),
      email,
      /*
       * NOT `spec.name`. The name on a company's roster is the COMPANY's record
       * and is sealed; the name on a person's own account is theirs and is not.
       * Copying one into the other puts a sealed value in an unsealed table,
       * which is `S-9` exactly — seal one place, leak it into another.
       */
      name: email,
      /* `PI4b`: `authHash: ''` and `authSalt: ''` were here, and the empty
       * strings were the tell — a seeded invitee never had a password to hash,
       * and the fields existed only because `User` demanded them. Both are
       * deleted from the type. */
      keyBundle: null, createdAt: new Date().toISOString(),
    };
    this.store.putUser(seedUser);

    /*
     * The token is read out of the delivery, exactly as an employee reads it out
     * of their email — rather than being handed over by the code that raised the
     * invite, which is the thing no real path may do.
     */
    this.acceptInvite(
      raw,
      sealHandover(
        {
          wrappingPublicKey: wk.publicKey,
          address: seededAddress(employee.id, this.network).bech32,
          /* X12 §2. The seed's dishonesty is unchanged and is not this round's:
           * this address was made HERE rather than on anybody's device, so
           * there is no wallet that showed a code and nobody to compare one
           * with. A code minted beside it would be the seed confirming its own
           * invention. */
          confirmation: null,
        },
        this.accounts.require(accountId).inboxPublicKey),
      seedUser.id);
    this.admit(employee.id, viewingKey, 'usr_seed_admin');
    return {
      employee: this.person(employee.id, viewingKey)!,
      secret: {
        employeeId: employee.id, name: employee.name, wrappingSecret: wk.secret, words,
      },
    };
  }

  /* ---------------- sealing the roster (S-9, M-90) ---------------- */

  /**
   * Seals a roster entry. The only way one reaches the store.
   *
   * `id` and `accountId` stay outside the envelope so a record can be found
   * without opening it; everything a person would call private goes inside.
   */
  /**
   * REFUSES A KEY THAT IS NOT THIS ACCOUNT'S, BEFORE ANYTHING IS SEALED WITH IT.
   * `C25`, found by audit 17 Aug.
   *
   * The viewing key arrives in a request body and was never checked. Seal one
   * roster entry under a stale or wrong key — a client holding an old key after
   * a rotation is the ordinary way — and **`listPeople` opens EVERY entry, so
   * the roster, and therefore every run, becomes permanently unreadable.**
   * Nothing deletes an employee, so there is no way back: the company's payroll
   * is frozen for good, behind one entry, by a call that returned success.
   *
   * Opening the account's own sealed record with the key first turns that into
   * a refusal before anything is written.
   */
  private requireKeyFor(accountId: string, viewingKey: Hex): void {
    this.accounts.open(accountId, viewingKey);
  }

  private putPerson(
    e: RosterEmployee, viewingKey: Hex,
    /**
     * What the drop box should hold afterwards. Omitted means "leave it alone".
     *
     * A PARAMETER RATHER THAN A SECOND WRITE, because `admit` has to fill the
     * roster and empty the box together. Two writes leave a window in which a
     * crash produces the exact thing the box exists to avoid: **two records of
     * where somebody's money goes**, which can then disagree. `grantAccess`
     * does its equivalent in one save and this now matches it.
     */
    inbox?: SealedEmployee['inbox'],
  ): void {
    const { id, accountId, wrappingPublicKey, status, ...secrets } = e;
    this.store.putEmployee({
      id, accountId, wrappingPublicKey, status, keyEpoch: this.accounts.keyEpochOf(accountId),
      inbox: inbox === undefined ? (this.store.getEmployee(id)?.inbox ?? null) : inbox,
      sealed: sealRecord('payroll', accountId, secrets satisfies EmployeeSecrets, viewingKey),
    });
  }

  /**
   * **AN ADDRESS THAT COMES BACK OUT OF THE SEAL GOES THROUGH THE SAME DECODE
   * AS ONE THAT WENT IN.** `A-1`, `C246`, `S6k`.
   *
   * `openRecord` returns JSON. `PayeeAddress` is a BRANDED type whose brand is
   * a compile-time symbol, so the object that comes back type-checks as one and
   * **is not one**: it is whatever fields were sealed, revived. `payee-address.ts`
   * says there is *"deliberately no way to make a `PayeeAddress` that skipped"*
   * the parse, and across this boundary that had quietly stopped being true.
   *
   * **It was harmless until this round and is not any more.** Every field a
   * caller read — `bech32`, `coinPublicKey`, `encryptionPublicKey` — was in the
   * sealed record, so a revived payee behaved like a parsed one. `S6k` added
   * `kind`, which is not in a record sealed before it and **is the field that
   * decides which door a payment leaves by** (`C246`). A roster sealed
   * yesterday would hand `buildRun` a payee with no kind.
   *
   * **The failure that would have been is loud rather than silent** — indexing
   * the details circuits by `undefined` throws where a run is BUILT, before
   * anything is approved or paid — and it is still a roster that stops working.
   * Re-parsing removes it entirely: what this returns came out of a decode, so
   * the kind is present and agrees with the bytes beside it, whenever the record
   * was written.
   *
   * **`payeeOf` SINCE `S12`, AND THAT IS THE WIDENING THE PREVIOUS COMMENT
   * PROMISED.** `C250`, `V-105`. It read `payeeAddress` and said *the day the
   * roster learns about public payees, this line widens deliberately and
   * `RosterEmployee.address` widens with it.* This is that day, and both moved
   * together in one round rather than one of them being noticed later.
   *
   * **A RECORD SEALED BEFORE THIS CHANGE IS UNAFFECTED, AND IT IS PINNED
   * RATHER THAN ASSERTED.** A `shield-addr` through `payeeOf` returns the
   * shielded kind, because the kind comes from the type segment the platform
   * put in the string; and the seal already carries the bech32 and the network
   * this line re-parses.
   *
   * **TWO FIXTURES, BECAUSE THERE ARE TWO OLD SHAPES AND ONE COMMENT CLAIMING
   * BOTH WOULD BE A `C221` MIRROR.** `a-payroll-run-is-always-private.test.ts`
   * §4 seals a pre-`S12` record, which HAS a `kind` because `S6k` added one;
   * `core.test.ts`'s *A ROSTER ADDRESS SEALED WITHOUT A KIND COMES BACK WITH
   * ONE* seals a pre-`S6k` record, which has none. The stored `kind` is thrown
   * away either way: everything below is rebuilt from `bech32`.
   *
   * **Parsed at the address's OWN recorded network, not this service's.**
   * `payeeOf` checks the network segment inside the string against the one it
   * is given, so a record whose two halves disagree is refused here rather than
   * paying somebody on another chain. Using `this.network` instead would refuse
   * a correctly sealed record belonging to a differently configured service,
   * which is a different and worse failure.
   */
  private open(r: SealedEmployee, viewingKey: Hex): RosterEmployee {
    const secrets = openRecord<EmployeeSecrets>('payroll', r.accountId, r.sealed, viewingKey);
    return {
      id: r.id, accountId: r.accountId,
      wrappingPublicKey: r.wrappingPublicKey, status: r.status,
      ...secrets,
      address: secrets.address
        ? payeeOf(secrets.address.bech32, secrets.address.network)
        : secrets.address,
    };
  }

  person(employeeId: string, viewingKey: Hex): RosterEmployee | null {
    const r = this.store.getEmployee(employeeId);
    return r ? this.open(r, viewingKey) : null;
  }

  /**
   * The roster, sorted by name.
   *
   * Sorting happens HERE and not in the store, because the store cannot read a
   * name any more — which is the property we wanted. A store that could sort by
   * name would be a store that could read it.
   */
  /**
   * **IS THERE SOMETHING WAITING TO BE ADMITTED FOR THIS PERSON?** `X11` §4.
   *
   * A boolean and deliberately not the contents. The drop box is sealed to the
   * account's inbox and this answers without opening it, so the one thing an
   * admin's roster screen needs — *is this row waiting on THEM or on US* — is
   * available without a second decryption and without this method ever holding
   * an address.
   *
   * `createRunFromRoster` already asks the same question inline to write the
   * two different refusals it names; this is that question with a name.
   */
  hasHandover(employeeId: string): boolean {
    return Boolean(this.store.getEmployee(employeeId)?.inbox);
  }

  /**
   * **THE SEALED DROP BOX ITSELF, FOR THE ONE MACHINE THAT CAN OPEN IT.**
   * `X12` §2, `docs/scope-invitations.md` §5,
   * `docs/how-money-can-be-lost.md` `C21`.
   *
   * §5: the admin's confirmation code is **computed on the ADMIN'S machine, not
   * ours** — *"if we computed it we would need the address, and the leak
   * returns through the door this section builds."* Which means the admin's
   * browser needs the ciphertext, and this is where it comes from.
   *
   * **NOTHING IS OPENED HERE AND NOTHING CAN BE.** What comes back is the same
   * blob `acceptInvite` was handed, sealed to the account's inbox public key;
   * the secret for that is derived from the account's viewing key, which does
   * not reach this method on any path. **It is not a widening**: anybody who can
   * ask for it is a member, every member already holds the viewing key that
   * would open it, and the value is unreadable to everybody else including us.
   *
   * `hasHandover` above stays, and stays a boolean: it answers the ROSTER
   * listing, where a sealed envelope per row would be a payload nobody reads.
   */
  handoverBlob(employeeId: string): ({ ephemeral: Hex } & Sealed) | null {
    const rec = this.store.getEmployee(employeeId);
    if (!rec) throw new Error('employee not found');
    return rec.inbox ?? null;
  }

  listPeople(accountId: string, viewingKey: Hex): RosterEmployee[] {
    return this.store.listEmployees(accountId)
      .map(r => this.open(r, viewingKey))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * **AND `active` IS NOT A STATUS SOMEBODY CAN JUST BE GIVEN.**
   * `docs/how-money-can-be-lost.md` `C156`, `docs/NEXT.md` `X11` §4.
   *
   * A roster entry becomes payable at `admit`, which checks five things and
   * folds in a handover the payee sealed. **This method assigned the status
   * with no check at all**, so a `pending` person with no address and no key
   * could be marked active from a roster row — and the comment in `App.tsx`
   * described that exact defect as fixed, because it WAS fixed in the
   * interface, by making the control explicit rather than a toggle. The
   * service still permitted it.
   *
   * **NOTHING WAS EVER PAID THAT WAY**: a run refuses by name for a person
   * with no address (`payroll.ts`, *"has no address. It has to come from their
   * own device or wallet"*), so the hole was caught downstream and money was
   * safe. That is why `C156` is not a money hole and why the row says so. It is
   * still a door that answers *yes* to a question only `admit` may answer, and
   * `X11` builds the control that does it properly — so this is the same turn
   * to close the door beside it.
   *
   * **`leaver` IS UNGUARDED AND MUST STAY THAT WAY.** Withdrawing a pending
   * person is the only exit from an invitation that can never be admitted
   * (`C28`), and a guard here would strand exactly the people that exit exists
   * for. Reinstating a LEAVER who was once admitted still works: they have an
   * address, because `admit` wrote one.
   */
  setStatus(employeeId: string, status: 'active' | 'leaver', viewingKey: Hex) {
    const e = this.person(employeeId, viewingKey);
    if (!e) throw new Error('employee not found');
    if (status === 'active' && !e.address) {
      throw new Error(
        `${e.name} has no address on file, so there is nowhere to pay them and nothing to `
        + 'make active. An address comes from their own device or wallet when they accept '
        + 'their invitation, and it becomes payable when an admin admits it — which is a '
        + 'different button, on purpose.');
    }
    e.status = status;
    this.putPerson(e, viewingKey);
    return e;
  }

  /** Draws a run from the active roster rather than an ad hoc list. */
  async createRunFromRoster(accountId: string, period: string, viewingKey: Hex, employeeIds?: string[]) {
    const all = this.listPeople(accountId, viewingKey);

    // Pre-flight. Blocking is the right call: silently escrowing someone's
    // salary data because they have not set up yet is worse than a delay.
    /*
     * TWO PENDING STATES, NAMED SEPARATELY. A-2, and it is B15's lesson applied
     * one step earlier: "outstanding" that covers two different situations is
     * how an operator stops looking. Somebody who has handed nothing over is
     * waiting on THEM; somebody whose drop box is full is waiting on US.
     */
    const pending = all.filter(e => e.status === 'pending');
    if (pending.length) {
      const waitingOnUs = pending.filter(e => this.store.getEmployee(e.id)?.inbox);
      const waitingOnThem = pending.filter(e => !this.store.getEmployee(e.id)?.inbox);
      const parts: string[] = [];
      if (waitingOnThem.length) {
        parts.push(
          `${waitingOnThem.map(e => e.name).join(', ')} `
          + `${waitingOnThem.length === 1 ? 'has' : 'have'} not set up yet`);
      }
      if (waitingOnUs.length) {
        parts.push(
          `${waitingOnUs.map(e => e.name).join(', ')} `
          + `${waitingOnUs.length === 1 ? 'is' : 'are'} waiting to be admitted by an admin`);
      }
      throw new Error(`payroll cannot run: ${parts.join('; ')}.`);
    }

    const roster = all
      .filter(e => e.status === 'active')
      .filter(e => !employeeIds || employeeIds.includes(e.id));
    if (roster.length === 0) throw new Error('no active employees to pay');
    /*
     * **A PAYROLL RUN IS ALWAYS PRIVATE, ASKED HERE AS WELL AS AT THE MONEY.**
     * `C250`, `movement.ts`.
     *
     * `paymentFactsFor` is the line nothing reaches the chain without, and it
     * is where the rule is load bearing. **This one is earlier and is for the
     * person**: a run refused at the moment it is drawn names the roster entry
     * and costs nothing, where the same refusal at payment time arrives after
     * payslips are sealed and a proposal is raised.
     *
     * **THE SAME FUNCTION, NOT A SECOND COPY OF THE SENTENCE.** A rule written
     * twice is this project's oldest failure, and a refusal written twice is
     * one that can be deleted in one place and go on looking enforced.
     */
    for (const e of roster) {
      if (e.address) payrollPayee(e.name, e.address);
    }
    if (this.store.listRuns(accountId).some(r => r.period === period && r.status !== 'draft')) {
      throw new Error(`a run for ${period} already exists`);
    }
    /*
     * NO CROSS-RATE CHECK, because there is nothing to cross. Exchange rates
     * are ruled out entirely: everybody is paid in the currency assigned to
     * them, so a person has ONE asset and a run in mixed currencies is simply
     * several people with different ones. There is no rate to record, nothing
     * to reconcile, and no run that has to be refused for want of a figure
     * nobody wrote down.
     */
    return this.createRun(
      accountId,
      period,
      roster.map(e => ({ name: e.name, asset: e.asset, amount: e.baseAmount })),
      viewingKey,
      roster,
    );
  }

  /**
   * WHAT THE CHAIN NEEDS, BUILT FROM THE ROSTER AND FROM NOTHING ELSE. A-2.
   *
   * This is the function that did not exist, and its absence is why a payee was
   * still "32 bytes somebody typed": nothing in this repo turned a roster into
   * `PaymentFacts`, so the only way to get them was to write them by hand.
   *
   * **There is no parameter here through which an address could be supplied.**
   * Each one comes from the payee's own sealed roster entry, which they put
   * there themselves. `V-78` option 3, and it is the whole reason identity was
   * sequenced ahead of the chain work.
   *
   * **`C9` is enforced here rather than assumed.** Three refusals, each naming
   * the person and what is actually wrong, because a payment settles
   * irreversibly the moment it lands and the failure it produces — money in an
   * address whose secrets nobody holds — is not recoverable by anybody.
   */
  /*
   * **`ShieldedPaymentFacts`, AND THE NARROWING IS THE POINT.** `S6k` §5.
   *
   * A vault holds both kinds of money and `payout-tree.ts` carries the kind per
   * payee. **This path produces private ones only**, and that is still true
   * after `S12` — but it is true for a DIFFERENT REASON than it was, and the
   * difference is the whole round.
   *
   * **IT USED TO BE TRUE BY ACCIDENT.** A roster address arrived through
   * `payeeAddress`, which refused anything but a `shield-addr`, so no public
   * payee could exist to reach this line. The narrowing held because the door
   * upstream was shut.
   *
   * **THE DOOR IS OPEN NOW AND THE NARROWING IS HELD BY A RULE.** `C250`. A
   * roster entry can carry either kind, so every payee on a run is put through
   * `payrollPayee`, which refuses a public one by name and returns the other
   * narrowed. **A payroll run cannot contain a public payee**, and if that
   * refusal is ever removed this function stops compiling rather than quietly
   * returning something its type says it cannot.
   *
   * **PER PAYEE AND NOT PER RUN.** The rule is about who is being paid, so it
   * is asked about each of them; a run-level check would pass a mixed run whose
   * first payee happened to be private.
   */
  paymentFactsFor(runId: string, viewingKey: Hex): ShieldedPaymentFacts[] {
    const run = this.requireRun(runId, viewingKey);
    return run.employees.map((e) => {
      const person = this.person(e.id, viewingKey);
      if (!person) {
        throw new Error(
          `${e.name} is not on the roster, so there is no address to pay them at. `
          + 'An ad hoc run can seal a payslip to somebody, but it cannot send them money.');
      }
      if (person.status !== 'active') {
        throw new Error(
          `${person.name} is ${person.status}, not active. Paying them now would settle `
          + 'into an address nobody has confirmed they can reach.');
      }
      if (!person.address) {
        throw new Error(
          `${person.name} has no address. It has to come from their own device or wallet — `
          + 'there is nowhere for an operator to enter one for somebody else, on purpose.');
      }
      return {
        payee: payrollPayee(person.name, person.address),
        token: toHex(assetIdBytes(e.asset)),
        amount: e.amount,
      };
    });
  }

  async createRun(
    accountId: string,
    period: string,
    specs: EmployeeSpec[],
    viewingKey: Hex,
    roster?: RosterEmployee[],
  ): Promise<{ run: PayrollRun; secrets: EmployeeSecret[] }> {
    this.accounts.require(accountId);
    if (specs.length === 0) throw new Error('a payroll run needs at least one employee');

    const employees: Employee[] = [];
    const secrets: EmployeeSecret[] = [];
    const payslips: PayrollRun['payslips'] = [];

    specs.forEach((spec, i) => {
      if (typeof spec.amount !== 'bigint') {
        throw new Error(`amount for ${spec.name} must be a bigint in minor units`);
      }
      if (spec.amount <= 0n) throw new Error(`amount for ${spec.name} must be positive`);
      this.assets.require(spec.asset);

      // A person on the roster keeps the same identity and key across every run.
      // Only an ad hoc run mints a new one, and then the secret is returned once.
      const existing = roster?.[i];
      /*
       * JOINED THROUGH THE RECORD, NOT THROUGH THE INDEX. `roster?.[i]` was
       * read a second time further down for `paidTo`, and changing it to
       * `roster?.[0]` left 145 tests green — on a hundred-person run that
       * prints one person's address on every payslip, which is the single field
       * a payee is told to check. One read, one variable.
       */
      const id = existing?.id ?? 'emp_' + nanoid(10);
      let publicKey: string;
      if (existing) {
        if (!existing.wrappingPublicKey) throw new Error(`${existing.name} has no key yet`);
        publicKey = existing.wrappingPublicKey;
      } else {
        /*
         * **THE ONE PLACE LEFT THAT MINTS A PAYSLIP KEY.** `PI2b`, `C135`.
         *
         * An ad hoc run pays somebody who is not on the roster, so there is no
         * handover, no wallet and nothing to derive from — `payslipKeypairFrom`
         * would have nothing to expand. So this stays random, the secret is
         * returned once, and `words` is absent to say so in the type.
         *
         * **IT IS NOT A GAP THIS ROUND LEFT OPEN BY OVERSIGHT.** Closing it
         * means an ad hoc payee handing over a public key first, which is an
         * onboarding flow and not a derivation — reported rather than smuggled
         * in. Until then, an ad hoc payslip is exactly what `C135` describes.
         */
        const wk = newWrappingKeypair();
        publicKey = wk.publicKey;
        secrets.push({ employeeId: id, name: spec.name, wrappingSecret: wk.secret });
      }

      employees.push({
        id, name: spec.name, wrappingPublicKey: publicKey,
        asset: spec.asset, amount: spec.amount,
      });

      // Two layers: seal the slip under a fresh key, wrap that key to the employee.
      /*
       * THE PAYSLIP CARRIES THE ADDRESS OF RECORD. A-10.
       *
       * The employee cannot read the company's roster — they hold no viewing
       * key, and must not. So the only way they can ever check that the address
       * the company holds for them is the one they handed over is for it to
       * come back to them **sealed to their own key**, which is what a payslip
       * already is.
       *
       * **AND HERE IS WHAT IT DOES NOT DO, because the first version of this
       * comment claimed otherwise and was wrong.** The payslip is sealed to the
       * payee's wrapping key — **which arrives in the SAME handover, in the same
       * drop box, as the address.** So whoever supplied the address supplied the
       * key that opens the slip reporting it: an impostor reads their own
       * address back, and the real employee gets "that key cannot open this
       * payslip". It is a mirror in the honest case and useless in the attack it
       * was written for.
       *
       * It is kept because it is the right field in the right place — what a
       * payee was paid to belongs on their payslip — and because it becomes a
       * real check the moment the two halves stop travelling together. **It is
       * not a defence today and must not be counted as one.** `C20`.
       */
      const slipKey = newSymmetricKey();
      const slip = seal(canonical({
        employeeId: id, name: spec.name, asset: spec.asset, amount: spec.amount, period,
        paidTo: addressOf(spec, existing),
      }), slipKey);
      payslips.push({ employeeId: id, wrapped: wrapKey(slipKey, publicKey), slip });
    });

    const run: PayrollRun = {
      id: 'run_' + nanoid(12),
      accountId,
      period,
      employees,
      payslips,
      /*
       * A SUBTOTAL PER ASSET, never one total. M-125.
       *
       * Adding 5,000 GBP to 5,000 USDC and displaying 10,000 is not an
       * approximation, it is meaningless — and the sufficiency check that used
       * that figure would have passed or failed for reasons unrelated to
       * whether the account can pay anybody.
       */
      totals: subtotals(employees.map(e => ({ asset: e.asset, amount: e.amount }))),
      proposalIds: {},
      status: 'draft',
    };
    this.putRun(run, viewingKey);
    return { run, secrets };
  }

  /**
   * Turns ONE ASSET'S worth of a run into a proposal. Individual amounts stay
   * inside the sealed payload.
   *
   * ONE PROPOSAL PER SETTLEMENT ASSET, and it was the visible consequence of
   * the contract moving one asset per round (M-125). A run that pays everybody
   * in pounds is one proposal, which is every run today. A run paying some
   * people in pounds and some in USDC is two, both referencing the same run id,
   * and both have to be paid before the run is done.
   *
   * **THE CIRCUIT THAT MOVED ONE ASSET IS GONE** (`C292`), so this shape is no
   * longer forced by the chain: a proposal's change commitment still names one
   * asset key and nothing opens it. What holds the rule now is
   * `AccountService.oneAssetOf`, which refuses a mixed batch here rather than
   * at settlement. Rule 27, said out loud.
   *
   * The alternative was a round carrying a fixed-width vector of legs, which
   * taxes every such round with the width of the widest run anybody might ever
   * make and reintroduces exactly the static cap M-106 spent a redeploy
   * removing.
   *
   * `asset` may be omitted only when the run has one, which keeps the common
   * case a one-argument call and makes the ambiguous case impossible to write
   * by accident.
   */
  async proposeRun(
    runId: string, viewingKey: Hex, proposedBy: string,
    /**
     * **THE RUN, AS THE CHAIN IS ASKED TO OPEN ONE — OR `null` FROM A CALLER
     * THAT HAS NONE.** `C375`, `S47`.
     *
     * **NULLABLE RATHER THAN OPTIONAL, so a call site that has no run material
     * has to say so out loud instead of forgetting** — the rule this file
     * already applies to `invite`'s `createdBy`. Every existing caller had to be
     * edited to pass `null`, which is the point: the change is visible at each
     * door rather than absorbed by a default.
     *
     * **WHAT IT COSTS TODAY, SAID PLAINLY: NOTHING IN `src/` CAN SUPPLY IT, SO
     * EVERY PRODUCT CALLER REFUSES.** Measured — `buildRun` and
     * `buildPayoutTree` (`src/midnight/payout-tree.ts`) have NO caller in
     * `src/` at all, only tests and `scripts/`; `PayrollRun` (`types.ts:1078`)
     * carries no root, no window and no vault; and `core/` may not import
     * `src/midnight/`, which is the dependency rule that keeps the standalone
     * build working. **That is a smaller change than it looks and a larger
     * finding than it looks, and this round says so rather than inventing a
     * root:** a run raised with a root nobody can produce payments against is
     * exactly as unpayable as `C375`'s governance round, and rule 9 forbids
     * writing a value no instrument read off anything.
     */
    payable: RunProposal | null,
    asset?: AssetId) {
    const run = this.requireRun(runId, viewingKey);
    if (run.status !== 'draft' && run.status !== 'proposed') throw new Error(`run is ${run.status}`);

    const legs = Object.keys(run.totals).sort();
    const leg = asset ?? (legs.length === 1 ? legs[0] : undefined);
    if (!leg) {
      throw new Error(
        `this run settles in ${legs.length} assets (${legs.join(', ')}) and a round moves one. ` +
          'Name which asset to propose — each is its own approval round.',
      );
    }
    if (!legs.includes(leg)) throw new Error(`this run pays nobody in ${leg}`);
    if (run.proposalIds[leg]) throw new Error(`the ${leg} leg of this run is already proposed`);

    const paid = run.employees.filter(e => e.asset === leg);
    const entries: ShieldedEntry[] = paid.map(e => ({
      id: 'ent_' + nanoid(10),
      kind: 'payroll',
      asset: e.asset,
      amount: e.amount,
      counterparty: e.name,
      memo: `${run.period} salary`,
      at: new Date().toISOString(),
      runId: run.id,
      recipientId: e.id,
    }));

    /*
     * **THIS CALLED `this.accounts.propose({kind: 'payroll'})` AND THAT WAS
     * `C375`, A `P0`.** `S47`.
     *
     * That door's payload hash is an APPLICATION digest — `commit(canonical(
     * {accountId, kind, sealedPayload, proposedBy}), '')`,
     * `src/core/account.ts:2252-2254` — and `recordPayment` recomputes
     * `proposalIdOf(runPayload(root, payees, opensAt, closesAt), forVault,
     * salt)` and matches only a `runPayload`
     * (`contracts/src/ConfidentialAccount.compact:2606-2609`). The two can
     * never be equal. **So every payroll run this product has ever raised was
     * raised as a governance round: no `runWindow` row, and a payload hash no
     * vault can ever present. Approved, paid for, and unpayable for ever** —
     * and `kind: 'payroll'` on the sealed record was the only thing anywhere
     * that said it was payroll at all.
     *
     * **THE FAILURE WAS SILENT AND LATE, WHICH IS WHY THE FIX IS A REFUSAL AND
     * NOT A FALLBACK.** Nothing refused: the round opened, collected real
     * signatures from real people and burnt a real fee, and the mismatch would
     * have surfaced at a vault on payday. A door that cannot raise a payable
     * run and says so costs a refusal; a door that raises an unpayable one
     * costs an approval round from every signer and is discovered by the people
     * who were meant to be paid. Rule 28.
     */
    if (!payable) {
      throw new Error(
        `the ${leg} leg of run ${run.id} cannot be proposed: this run has no payout root, no ` +
          'payment window and no vault, so there is nothing a vault could ever be presented ' +
          'with. A payroll run is raised against a merkle root over blinded payee leaves ' +
          '(src/midnight/payout-tree.ts), a window in seconds, and the vault that will pay it. ' +
          'None of the three has a writer in this product yet — the vault path is not built ' +
          '(C292) — so this refuses rather than raising a governance round that no vault can ' +
          'ever match, which is what it did until C375.',
      );
    }
    if (payable.payees !== BigInt(paid.length)) {
      throw new Error(
        `this run pays ${paid.length} people in ${leg} and the run material names ` +
          `${payable.payees}. The payee count is bound into the payload the signers approve ` +
          '(compact:2606-2609), so a run cannot be declared finished early or made never to ' +
          'finish — and a count that disagrees with the roster is one of the two.',
      );
    }

    const proposal = await this.accounts.proposeRun({
      accountId: run.accountId,
      viewingKey,
      /*
       * Public summary. Deliberately says headcount and period, never amounts —
       * and NOT the asset either, which is the new thing to be careful about.
       * The asset is inside the sealed payload and blinded on chain, so naming
       * it in a plaintext summary would undo `assetKeyOf` for the price of a
       * string.
       */
      summary: `Payroll ${run.period}, ${paid.length} recipients`,
      payload: { runId: run.id, entries },
      asset: leg,
      run: payable,
      proposedBy,
    });

    run.status = 'proposed';
    run.proposalIds = { ...run.proposalIds, [leg]: proposal.id };
    this.putRun(run, viewingKey);
    return proposal;
  }

  /*
   * **`settle` STOOD HERE AND IS DELETED.** `C292`, `S26`.
   *
   * It called `accounts.execute`, which spent the account's own balance. The
   * balance is gone — the account is an authority over a vault's money, not a
   * holder of any — so the method went with it, along with its two HTTP routes
   * and the screens' Settle controls.
   *
   * **NOTHING IN THIS SYSTEM PAYS ANYBODY NOW.** A run is raised, approved, and
   * stops. That is the accepted cost of taking these bytes at the redeploy
   * rather than at a later one.
   *
   * WHAT REPLACES IT IS KNOWN AND IS NOT BUILT: an approved run is presented at
   * a VAULT, which pays each payee and calls `recordPayment` on this account —
   * already in the contract, and the only circuit a vault calls. `run.status`,
   * `run.settledAt` and `isSettled` below are kept because runs already settled
   * must still read correctly.
   */

  private isSettled(proposalId: string | undefined, viewingKey: Hex): boolean {
    if (!proposalId) return false;
    return this.accounts.requireProposal(proposalId, viewingKey).status === 'executed';
  }

  /** What one employee can see. Requires their own secret and returns only their line. */
  employeeView(runId: string, employeeId: string, wrappingSecret: Hex) {
    /*
     * NO account viewing key, and that is the guarantee. An employee holds only
     * their own secret, and payslips sit outside the sealed envelope precisely
     * so this path never needs the company's key.
     */
    const run = this.store.getRun(runId);
    if (!run) throw new Error('run not found');
    const slip = run.payslips.find(p => p.employeeId === employeeId);
    if (!slip) throw new Error('no payslip for that employee in this run');

    let decoded: unknown;
    try {
      const slipKey = unwrapKey(slip.wrapped, wrappingSecret);
      // `parseCanonical`, matching the `canonical` the slip was sealed with:
      // the amount inside is a bigint and a plain parse hands back an object.
      decoded = parseCanonical(unseal(slip.slip, slipKey));
    } catch {
      throw new Error('that key cannot open this payslip');
    }
    return {
      runId: run.id,
      period: run.period,
      status: run.status,
      settledAt: run.settledAt ?? null,
      payslip: decoded,
    };
  }

  /* ---------------- selective disclosure ---------------- */

  /**
   * Proves the total paid and the headcount for a period, and proves nothing else.
   * The auditor receives a statement and a proof. Individual amounts are never
   * part of the public inputs, so there is nothing in the attestation to leak.
   */
  async attestPayrollTotal(
    runId: string,
    viewingKey: Hex,
    /** Which subtotal is being attested. A run has one per asset, never one total. */
    asset: AssetId,
    validForDays = 30,
  ): Promise<Attestation> {
    const run = this.requireRun(runId, viewingKey);
    /*
     * **THIS GATE CANNOT PASS, AND THE SENTENCE NOW SAYS SO.** `T-217`/`F10`,
     * `T-234`, `S47`. Rule 14, and `C178`'s species.
     *
     * *"cannot attest an unsettled run"* stood here, and it describes a run —
     * as though settling one were a thing a person could go and do. **Measured:
     * `run.status` is assigned in exactly two places in `src/`, `'draft'`
     * (`:2012`) and `'proposed'`, and `'settled'` is assigned NOWHERE; nor is
     * `run.settledAt`, which is only read.** The writer that set both, `settle`,
     * went with the balance (`C292`, `S26`), and the note twenty lines above
     * says so in its own words: *"NOTHING IN THIS SYSTEM PAYS ANYBODY NOW."*
     *
     * **SO `this.proofs.prove` BELOW IS UNREACHABLE, AND SO IS
     * `store.putAttestation`, WHICH MAKES `verifyAttestation` UNREACHABLE
     * TOO** — the store can never hold a row. `SimulatedProofSystem` is wired
     * live and both of its methods are dead in the shipped product.
     *
     * **NOT REMOVED, AND THE REASON IS RULE 22b RATHER THAN RELUCTANCE:** the
     * statement is real and is what a vault-settled run will prove. What is
     * corrected is the claim — a refusal names the door that resolves it
     * (rule 19), and when there is no door the honest refusal says that
     * instead of naming a step nobody can take.
     */
    if (run.status !== 'settled') {
      throw new Error(
        `run ${run.id} is ${run.status}, and no run in this product can be anything else: ` +
          'a payroll total is proved from a run a VAULT has paid, and the vault payment path ' +
          'is not built (C292 removed the only path that settled a run). Nothing assigns ' +
          "'settled' anywhere in this product, so this is not waiting on a step you can take. " +
          'Selective disclosure returns with vault settlement.',
      );
    }
    const total = run.totals[asset];
    if (total === undefined) throw new Error(`this run pays nobody in ${asset}`);
    const registered = this.assets.require(asset);

    const paid = run.employees.filter(e => e.asset === asset);
    /*
     * `asset` and `decimals` ARE PUBLIC INPUTS, and leaving them out would make
     * the attestation unreadable rather than private. "The total was 500000" is
     * five thousand pounds, half a USDC, or a rounding error in ether, and
     * nothing in the number says which — so an auditor could not check it and a
     * court could not use it. What stays out is every individual amount, which
     * is the thing this exists to withhold.
     */
    const publicInputs = {
      runId: run.id,
      period: run.period,
      asset,
      decimals: registered.decimals,
      total,
      headcount: paid.length,
    };
    const proof = await this.proofs.prove('payroll-total', publicInputs, {
      amounts: paid.map(e => e.amount),
    });

    const now = new Date();
    const att: Attestation = {
      id: 'att_' + nanoid(12),
      accountId: run.accountId,
      circuit: 'payroll-total',
      statement:
        `Total ${asset} payroll for ${run.period} was ${formatAmount(total, registered)} ` +
        `across ${paid.length} recipients. No individual amount is disclosed.`,
      publicInputs,
      proof,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + validForDays * 86400_000).toISOString(),
    };
    this.store.putAttestation(att);
    return att;
  }

  /**
   * **THERE IS NO BALANCE TO ATTEST TO.** `C292`, `S26`.
   *
   * This read `state.balances[asset]` and proved it was at least `threshold`.
   * The account keeps no balance, so the only honest answer this could give is
   * "at least zero", and issuing an attestation saying an account HOLDS an
   * amount when it holds nothing is the exact failure `rule 14` and `rule 29`
   * exist to prevent — a signed claim about money, from a system with no money
   * in it.
   *
   * **REMOVING THE FEATURE IS NOT THIS ROUND'S TO DO.** The brief reserves
   * `attestSolvency` and its screen for a round of their own, and reserving
   * them is not the same as leaving them issuing a true-by-vacuity attestation
   * — which is what this would do if it were left reading a field that is gone.
   * So the method refuses and the screen is untouched, for that round to take
   * whole. When solvency comes back it is the VAULT's holding that is proved,
   * which is a different statement over a different commitment.
   */
  async attestSolvency(
    accountId: string,
    _viewingKey: Hex,
    asset: AssetId,
    _threshold: bigint,
    _validForDays = 30,
  ): Promise<Attestation> {
    this.assets.require(asset);
    throw new Error(
      `account ${accountId} cannot attest solvency in ${asset}: this account holds no balance ` +
        'at all. It is an authority over a vault, not a holder of money (C292), so there is ' +
        'nothing here to prove a threshold against. Proving what a VAULT holds is a different ' +
        'statement and is not built.',
    );
  }

  /**
   * **IT CAN ONLY EVER ANSWER `false`, AND THAT IS THE DIRECTION THAT CALLS A
   * TRUE CLAIM FALSE.** `T-217`, `T-234`, `S47`.
   *
   * `store.putAttestation` has exactly one caller — inside `attestPayrollTotal`
   * above, BELOW a gate nothing can pass — so the attestation store can never
   * hold a row, `:getAttestation` always answers null, and `this.proofs.verify`
   * is never reached. **A caller cannot tell that apart from *the proof did not
   * verify*, which is the worst of the two readings to be given by accident.**
   * Through HTTP it is worse still: `ownsAttestation` 404s on a null lookup,
   * so the hosted route never reaches this method at all.
   *
   * The refusal is kept rather than the method deleted, for `attestPayrollTotal`'s
   * reason: the statement is real and returns with vault settlement.
   */
  async verifyAttestation(attestationId: string): Promise<boolean> {
    const att = this.store.getAttestation(attestationId);
    if (!att) {
      /*
       * **THROWS RATHER THAN ANSWERING `false`.** No attestation with this id
       * exists, and no attestation with ANY id can exist yet — answering
       * `false` states that a proof was checked and failed, which is a claim
       * about a proof that was never made.
       */
      throw new Error(
        `there is no attestation ${attestationId}, and there is none with any id: issuing one ` +
          'requires a run a vault has paid, and the vault payment path is not built (C292). ' +
          'This is not a proof that failed to verify — no proof was ever issued.',
      );
    }
    if (new Date(att.expiresAt) < new Date()) return false;
    return this.proofs.verify(att.circuit as any, att.publicInputs, att.proof);
  }

  /* ---------------- sealing runs (S-9) ---------------- */

  private putRun(run: PayrollRun, viewingKey: Hex): void {
    const { employees, totals, proposalIds, ...operational } = run;
    this.store.putRun({
      ...operational,
      // Outside the envelope so a run can be found by its proposals; the map
      // that says which asset each leg is in stays inside, so the store cannot
      // see that this company pays anyone in ether.
      proposalIds: Object.values(proposalIds).sort(),
      keyEpoch: this.accounts.keyEpochOf(run.accountId),
      sealed: sealRecord(
        'payroll', run.accountId,
        { employees, totals, proposalIds } satisfies RunSecrets, viewingKey,
      ),
    });
  }

  private openRun(r: SealedRun, viewingKey: Hex): PayrollRun {
    // `proposalIds` is dropped from the operational half and taken from the
    // envelope instead. Two copies of the same list, one of them lossy, is the
    // shape this project keeps recording — and the outside one has no assets.
    const { sealed, keyEpoch, proposalIds: _outside, ...operational } = r;
    return { ...operational, ...openRecord<RunSecrets>('payroll', r.accountId, sealed, viewingKey) };
  }

  requireRun(id: string, viewingKey: Hex): PayrollRun {
    const r = this.store.getRun(id);
    if (!r) throw new Error('run not found');
    return this.openRun(r, viewingKey);
  }
}

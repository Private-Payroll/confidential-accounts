import { nanoid } from 'nanoid';
import {
  newWrappingKeypair, newSymmetricKey, wrapKey, unwrapKey, seal, unseal, canonical,
  parseCanonical, toHex, utf8, type Hex, type Sealed,
} from './crypto.js';
import { sha256 as sha256Bytes } from '@noble/hashes/sha2.js';
import { inviteKeyOf } from './store.js';
import { companyAddressForOffer } from './company-address.js';
import { newWords } from 'midnight-identity';
/* The code the payee's wallet produced, checked where the roster is
 * written. Same function the admin's browser runs, one module, so the two
 * sides of the comparison cannot drift apart. */
import { addressFingerprint, FingerprintError } from 'midnight-identity/profile/fingerprint';
import { payslipKeypairForWallet } from './payslip-key.js';
import type { SealedPayslip } from './payslip-open.js';

/**
 * **THE ORIGIN THE SEED'S STAND-IN WALLET IS ASKED AT, AND IT IS NOT AN
 * INGREDIENT.**
 *
 * `unlock.ts` gates on the origin and derives from the company alone, so this
 * value cannot change a single byte of any key. It exists because the wallet
 * refuses to answer an origin it cannot make sense of, and something has to be
 * passed. **A test asserts that two different origins give the same key**,
 * which is what keeps this from quietly becoming load bearing.
 */
const SEED_WALLET_ORIGIN = 'https://payroll.example';
import type { AssetId } from './assets.js';
import { assets as defaultAssets, subtotals, formatAmount, ledgerTokenOf, ledgerFormOf } from './assets.js';
import type { Account, Employee, PayrollRun, SealedRun, ShieldedEntry, Attestation, RosterEmployee, SealedEmployee, Invite, User, RunSkip, RunSkips, RunRetry, RunRepeatRecord, RunPayout, Proposal } from './types.js';
import { sealRecord, openRecord, sealToInbox, openFromInbox } from './sealed-records.js';
import {
  sealHandover, openHandover, type SealedHandover,
} from './invite-handover.js';
import {
  payeeAddressFromKeys, payeeOf, type Payee, type PayeeAddress,
} from '../midnight/payee-address.js';
import { payrollPayee } from './movement.js';
import type { NetworkName } from '../midnight/network.js';
import type { ShieldedPaymentFacts, PaymentFacts } from '../midnight/payout-tree.js';
import type { RunInputs } from '../midnight/run-status.js';
import { emptyRegister, decide, registerFor, skippedIndices } from '../midnight/run-skips.js';
import type { RunMaterial, RetryMaterial } from '../midnight/run-material.js';
import type { PayoutSeed } from '../midnight/run-keys.js';

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
 * **HOW LONG AN OFFER IS AN OFFER.**
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
 * HOW AN INVITE REACHES THE PERSON IT IS FOR.
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
   * admitted, which is the moment the token stops being useful.
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
   * Hashing the stored token protects the database; it does nothing about this
   * array, which held every raw token for the life of the process with the name
   * and email in the clear beside it — the whole mapping, unsealed, next to the
   * ciphertext it opens.
   *
   * Forgetting on admit is a narrowing, not a fix: an invite that is never
   * redeemed is still held for ever, and the token still travels in a URL path.
   * Both are recorded elsewhere rather than claimed closed here.
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

/**
 * **WHAT AN ADMIN HAS TO SAY TO RUN PAYROLL WITHOUT SOMEBODY ON IT.**
 *
 * **NOT A BOOLEAN, AND THAT IS THE WHOLE OF IT.** A flag says *yes, whatever
 * that was*; it can be set by a screen that never showed a name, carried over
 * from a previous attempt, or defaulted true by a client somebody wrote in a
 * hurry — and in each case whoever happens to be pending at the moment the
 * button is pressed is dropped without anybody reading their name. **That is
 * the silent skip the old refusal existed to prevent, and it would be the way
 * this change reintroduced it.**
 *
 * So the acknowledgement carries the NAMES, the PERSON accepting it, and the
 * REASON — and the door compares the names against the ones it is actually
 * about.
 */
export interface SkipAcknowledgement {
  /**
   * **THE SAME SET as the people this run would leave out — neither a superset
   * nor a subset of it.**
   *
   * A run that skips somebody the admin did not name is the silent drop. A run
   * naming somebody who is NOT being skipped is the same failure seen from the
   * other side: the list the admin read is not the list the run would act on,
   * so their agreement is about a different payroll. Both are refused.
   *
   * **COMPARED AS A SET AND NOT AS A LIST**, said here because the first
   * wording of this sentence said *exactly these ids* and a reviewer was right
   * that a repeated id passes. It should: a duplicate is the same person named
   * twice, one `RunSkip` is still recorded, and nobody is dropped. Order is not
   * compared either, for the same reason.
   */
  employeeIds: string[];
  /**
   * **WHO IS ACCEPTING IT, AND IT IS NOT SOMETHING A CALLER GETS TO CHOOSE
   * WHERE THERE IS ANYBODY TO ASK.**
   *
   * Checked by `decide`, which refuses an unattributed decision. **What `decide`
   * cannot check is whether the name is the caller's own**, and this service
   * cannot either: it runs with no server in front of it. So the served routes
   * take this from the signed-in caller and do not read it off the request body — see
   * `src/server/index.ts`'s run-creation route, which says why at length. **A
   * string here is a claim; it stops being one at the door.**
   */
  by: string;
  /** Why, in their words. Checked by `decide`, which refuses a blank reason on a skip. */
  reason: string;
}

/**
 * **THE RUN'S RECORD OF WHO IT LEFT OUT, BUILT THROUGH `run-skips.ts` RATHER
 * THAN BESIDE IT.**
 *
 * The skip reader was written and tested against the compiled contract, and
 * wired it to nothing. **This is its second and closer caller and it does not
 * close that** — the index `runStatus` reads is a different one, over a
 * leg's payout leaves and under the proposal id that leg was raised with, and
 * joining the two is still owed.
 *
 * **EVERY RULE ABOUT A SKIP IS ASKED BY CALLING `decide`, AND NOT ONE OF THEM
 * IS RESTATED HERE.** An unattributed decision, a blank reason and an index
 * outside the run are refused by that function, in its own sentences, because a
 * rule written twice is this project's oldest failure and a refusal written
 * twice is one that can be deleted in one place and go on looking enforced.
 * **What that costs is that the values handed to it have to be capable of
 * failing its checks** — see the note on `reason` below, which is where the
 * first draft of this function quietly stopped being able to. **The
 * consequence is deliberate: this throws before a run exists**, so an
 * acknowledgement with nobody's name on it produces no payroll rather than a
 * payroll with an unsigned skip in it.
 */
export const recordSkips = (
  runId: string, people: RunSkip[], ack: SkipAcknowledgement, at: string,
): RunSkips => {
  let decisions = emptyRegister(runId, people.length);
  people.forEach((person, index) => {
    decisions = decide(decisions, {
      index,
      skip: true,
      by: ack.by,
      at,
      /*
       * **THE OPERATOR'S WORDS, VERBATIM AND ALONE.**
       *
       * **THE FIRST DRAFT COMPOSED THIS** — the operator's reason, then which
       * of the two pending states the person is in — and a test written to
       * watch `decide` refuse a blank reason went green instead. **The
       * composition is never blank, so `decide`'s check could not fail, and the
       * rule this function's own comment says it delegates was not being
       * asked.** A guard whose written reason does not match its behaviour is
       * the next round's false confidence, and this file already carries that
       * sentence about somebody else's code.
       *
       * So the two facts stay apart, which is what they are: **`reason` is what
       * a person said, and `RunSkips.people[index].waiting` is what the system
       * measured.** They travel together by construction — the index and the
       * list are one field, at one index — so a report has both without either
       * being able to defeat a check on the other.
       */
      reason: ack.reason,
    });
  });
  return { people, decisions };
};

/** The numbers on a run. Everything else about it is operational. */
type RunSecrets = Pick<PayrollRun, 'employees' | 'totals' | 'proposalIds' | 'payout' | 'skips' | 'repeats'>;

/**
 * **THE PEOPLE ONE LEG OF A RUN PAYS, THROUGH ONE FILTER.**
 *
 * A round moves one settlement asset, so everything about a leg — who is in it,
 * how many there are, whose leaf sits where — is this list. **The ORDER is part
 * of the run**: a payee's index is where their leaf sits and what their merkle
 * path proves, so the same payroll filtered twice must produce the same
 * sequence. Written once so that the count the signers approve and the tree the
 * vault proves against cannot be drawn from two different lists.
 */
const legEmployees = (run: PayrollRun, leg: AssetId): Employee[] =>
  run.employees.filter(e => e.asset === leg);

/**
 * **WHAT ONE LEG'S PAYEE SECRETS ARE DERIVED FROM, AND WHY IT IS NOT THE RUN'S
 * OWN ID.**
 *
 * Every per-payee nonce and blinding on a run comes out of this identifier and
 * the account's seed. Two legs of one payroll are two approvals over two
 * separate trees, and if they shared an identifier they would derive the SAME
 * secrets for position 0 of each — and a nonce is published by the payment that
 * spends it, so paying the first leg would hand a watcher the second leg's.
 * They are different runs by the only measure that matters here, so they get
 * different identifiers.
 *
 * The value is stored with the leg rather than recomputed on demand, so that
 * changing this rule cannot strand a run that is already approved.
 */
const runIdForLeg = (run: PayrollRun, leg: AssetId): string => `${run.id}:${leg}`;

/**
 * **WHICH LEG OF A RUN IS BEING ACTED ON, RESOLVED IN ONE PLACE.**
 *
 * A run that settles in one asset needs nobody to say which; a run that settles
 * in two cannot be guessed at, because guessing would act on one set of people
 * and report about another. Every door that works a leg at a time asks here, so
 * a caller cannot get one answer at the raise and a different one at the read.
 */
/**
 * **WHICH LEG A PAYMENT VIEW IS ABOUT, RESOLVED OVER THE LEGS THAT HAVE
 * MATERIAL RATHER THAN OVER THE PAYROLL.**
 *
 * A run's payroll says which currencies it settles in; its payout record says
 * which of those have actually been raised. A view is about the second, and the
 * difference matters at both ends: a run with nothing raised has nothing to
 * report and says so once, in the shape every reader already handles, rather
 * than refusing for want of an argument that would not have helped; and a run
 * with two legs raised cannot be reported on without being told which, because
 * answering about one is how a screen comes to call a payroll complete while
 * everybody in the other currency is still owed.
 *
 * `null` where there is nothing to report on at all.
 */
const raisedLegOf = (run: PayrollRun, asset: AssetId | undefined): AssetId | null => {
  const raised = Object.keys(run.payout ?? {}).sort();
  if (raised.length === 0) return null;
  const leg = asset ?? (raised.length === 1 ? raised[0] : undefined);
  if (!leg) {
    throw new Error(
      `this run has payout material for ${raised.length} assets (${raised.join(', ')}) and a ` +
        'payment view is about one of them. Name which asset — each is its own approval round ' +
        'over its own set of payees, and an answer about one says nothing about the other.',
    );
  }
  return raised.includes(leg) ? leg : null;
};

const legOf = (run: PayrollRun, asset: AssetId | undefined): AssetId => {
  const legs = Object.keys(run.totals).sort();
  const leg = asset ?? (legs.length === 1 ? legs[0] : undefined);
  if (!leg) {
    throw new Error(
      `this run settles in ${legs.length} assets (${legs.join(', ')}) and a round moves one. ` +
        'Name which asset — each is its own approval round.',
    );
  }
  if (!legs.includes(leg)) throw new Error(`this run pays nobody in ${leg}`);
  return leg;
};
import type { AccountService, RaiseHalf } from './account.js';
import type { ProofSystem, RunProposal } from './ledger.js';
import type { DataStore } from './store.js';
import { paymentChecked, paymentsCheckedDigest, type PaymentChecked } from './device-raise.js';
import { isLiveRound, sameList, untoldRetryRounds } from './retry-cover.js';

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
   * **NULL FOR A PERSON WITH NO EMAIL, AND NEVER AN EMPTY STRING.**
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
   * **STILL HERE, AND NO LONGER A RANDOM NUMBER.**
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
   * **WHAT THE SECRET ABOVE IS DERIVED FROM, AND THE WHOLE OF THE FIX.**
   *
   * The person's own wallet. Given back by the seed because the seed is
   * standing in for eight people's devices and has to hold what each of them
   * would hold — see `hireDirect`'s header. **A real employee's words never
   * reach this server**, and nothing in this product persists this field: it is
   * returned once, exactly as `wrappingSecret` always was.
   *
   * A random key has to be kept and a kept key can be lost. This one is a pure
   * function of twenty-four words and a chain address, so a person who still
   * has their wallet still has every payslip they were ever issued.
   *
   * **ABSENT MEANS THE SECRET ABOVE IS A RANDOM NUMBER THAT NOTHING CAN WORK
   * OUT AGAIN**, and that is not a formality — it is the one remaining place
   * the old hazard is still live. An AD HOC run pays somebody with no roster
   * entry, so there is no wallet to derive from and `createRun` mints one
   * (`payroll.ts`, the `else` branch below). The field is optional so that the
   * difference is visible in the type rather than in a comment: **a secret with
   * no words beside it is a secret somebody has to keep.**
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
     * WHICH NETWORK THIS COMPANY'S MONEY IS ON.
     *
     * Load bearing rather than decoration: `admit` re-parses a handed-over
     * address against THIS, not against the network the handover claims for
     * itself. An employee who pastes a preview address into a stagenet company
     * is refused at onboarding, which is free, instead of at payment time,
     * which is not — and a coin public key is network-independent bytes, so
     * nothing further down would have objected.
     */
    private network: NetworkName = 'undeployed',
    /** How an employee invite reaches the employee. Never the operator. */
    private delivery: InviteDelivery = new RecordingInviteDelivery(),
  ) {}

  /**
   * **THE LEGS THIS PROCESS IS RAISING RIGHT NOW** - a leg's own proposal, or a
   * retry on it - from the moment the run's material for it is written until
   * the raise answers.
   *
   * A raise writes the leg's material, then awaits the vault check and, from
   * here, the chain; only afterwards does the run say which proposal the leg is.
   * Two raises of one leg that overlap in that window would each find the leg
   * unraised and write two proposals over the same people, and a leg raised
   * again while a retry on it is in that window would replace the material the
   * retry was built against. So a second raise of the same leg, of either kind,
   * is refused while one is on its way, as having raised nothing. **It holds
   * nothing else** - approvals, withdrawals, standing reads and other legs all
   * proceed - and an entry leaves when its raise answers, whether it succeeded
   * or failed. It is in memory: a restart clears it, and what the run and the
   * proposals it names say is what the next raise is checked against.
   */
  private readonly raising = new Set<string>();

  private holdTheLeg(run: PayrollRun, leg: AssetId): () => void {
    const key = `${run.id} ${leg}`;
    if (this.raising.has(key)) {
      throw new Error(
        `the ${leg} leg of run ${run.id} is being raised right now by another request, so it was not raised `
        + 'again. Nothing was raised. Once that raise has answered, the run says where the leg stands.');
    }
    this.raising.add(key);
    return () => { this.raising.delete(key); };
  }

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
     * WHO IS MINTING THIS TOKEN.
     *
     * Recorded so `admit` can RECORD a handover redeemed by the same person who
     * raised it — as `selfRaised`, visible to an admin. It used to REFUSE; that
     * refusal asked about the wrong person, and its price was a second flow for
     * founders, which became a hole of its own. Nullable rather than optional
     * so a call site that has no user — a seed, a test — has to say so out loud
     * instead of forgetting.
     */
    createdBy: string | null = null,
  ): {
    employee: RosterEmployee; sentTo: string; delivered: boolean;
    /**
     * **THE LINK, ONCE.** See the note where it is returned: this is
     * the only moment the raw token is ever visible, and every listing route
     * strips it from here on.
     */
    raw: string;
  } {
    /*
     * **AN INVITATION IS ADDRESSED TO SOMEBODY.**
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
    this.refuseAPayeeWhoCannotBePaid(spec);
    const { raw, sentTo, ...rest } = this.raise(accountId, spec, viewingKey, createdBy);
    /*
     * **THE RAW TOKEN COMES BACK TO WHOEVER RAISED IT, AND THIS REVERSES AN
     * EARLIER DECISION. DELIBERATELY, WITH THE ARGUMENT.**
     * `docs/scope-invitations.md` §4 decision 1, 22 Aug.
     *
     * It was dropped here on the reasoning that *the token does not come back
     * to the caller, so an operator cannot redeem it*. That reasoning assumed a
     * MAILER — a channel that reaches the employee without passing through the
     * admin's hands. **There is no mailer and there is not going to be one.
     * Decided 22 Aug:** the admin is hiring this person and already holds their
     * email in their own systems, so we produce a link and they send it. **So
     * we never learn the employee's email address at all** — not in a column,
     * not in a provider's logs, not in a bounce report — which is a stronger
     * property than sending it carefully.
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
     * already open, and it has already been reproduced end to end** — an
     * operator types the employee's email at hire time, registers a second
     * identity at a mailbox they own, redeems with an address they hold, and
     * admits; every refusal passes, because the operator controls BOTH sides of
     * the only positive check in the flow. This line does not create that
     * capability and does not widen it: it removes one step from an attack that
     * costs one throwaway address and one registration either way.
     *
     * **AND IT WAS NEVER TRUE THAT THE PROCESS DID NOT HOLD ONE.**
     * `RecordingInviteDelivery` keeps every raw token it is given, in memory,
     * for the life of the process, with the name and the email in the clear
     * beside it. The rule this reverses was already only a rule about which
     * VARIABLE held it.
     *
     * ── WHAT DOES NOT CHANGE, AND IT IS THE FIRST RULE OF THIS FLOW ──────
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
    /* Before a record is sealed with it, not after. */
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
     * The invite carries NO name, email or salary.
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
     * it can read what they are being offered, and we cannot.**
     */
    const raw = 'inv_' + nanoid(18);
    const invite: Invite = {
      token: inviteKeyOf(raw),
      accountId, kind: 'employee',
      createdAt: new Date().toISOString(),
      createdBy,
      /*
       * **EVERY INVITATION HAS A DEADLINE, AND IT IS SET WHERE ONE IS MADE
       * RATHER THAN WHERE ONE IS SHOWN.**
       * `docs/scope-invitations.md` §9: *no invitation without an expiry*. A
       * door that could mint one without a deadline is a door somebody calls.
       */
      expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS).toISOString(),
      subjectId: employee.id,
      /*
       * **THE OFFER NAMES THE COMPANY TWICE, AND THE SECOND ONE IS NOT A
       * LABEL.**
       *
       * `company` is a NAME, for a person to read. **`companyAddress` is the
       * company's own account contract address**, and it is here because the
       * key that opens this person's payslips is
       * `payslipKeypairFrom(companyKey)` and the wallet derives that company
       * key from the address and from nothing else. An invitee is by definition
       * not a member, so `companyForSession` cannot serve them and `POST
       * /api/accounts/:id/unlock` is shut to them — **and inventing a second
       * key path for invitees is forbidden by name.** It travels here or the
       * invitee derives a key nobody else can reproduce.
       *
       * **`inboxPublicKey` is here for the other half of the same change.** The
       * sealing of the receiving address moved onto the invitee's own device,
       * and a browser cannot seal to an inbox it has not been given.
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
       * assigned. That is the address gate, unchanged and in the same words:
       * the refusal arrives on the invitee's screen rather than stopping a
       * hire.
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
     * DELIVERED, NOT RETURNED.
     *
     * The token does not come back to the caller, so an operator cannot redeem
     * it. Everything else in this method is unchanged; this one line is what
     * makes "the payee's key comes from the payee" true rather than claimed.
     */
    /*
     * **NOTHING IS DELIVERED TO NOBODY.**
     *
     * A null email reaches here from `addSelfAsPayee` alone, where the token is
     * redeemed inside the same call and never leaves the method. Calling the
     * delivery with a null address would put a raw invite token into the
     * delivery port's memory — beside no name and no mailbox — for a
     * conversation that has no second party. Raw-token retention, bought for
     * nothing.
     */
    if (spec.email !== null) {
      this.delivery.send({ email: spec.email, name: spec.name }, raw, accountId);
    }
    /*
     * `delivered` is false today and that is not a detail. Until a mailer
     * exists, **nobody can complete onboarding**: the token reaches no one, the
     * roster entry stays `pending`, and a run refuses to build while anybody is
     * pending. An operator is entitled to be told that at the moment they hire
     * somebody rather than on payday.
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
     * `Payee` rather than `PayeeAddress`. A member adding their own address, or
     * a company recording its own, hands over whatever their wallet produced,
     * and the string says which kind it is.
     */
    handover: { wrappingPublicKey: Hex; address: Payee },
  ): RosterEmployee {
    const account = this.accounts.require(accountId);
    if (!account.memberUserIds.includes(userId)) {
      throw new Error(
        'only somebody already on this account can add themselves as a payee. '
        + 'Anybody else is an employee, and an employee is invited');
    }
    this.refuseAPayeeWhoCannotBePaid(spec);

    /*
     * "SELF" IS ENFORCED HERE, NOT ASSERTED IN THE METHOD NAME.
     *
     * The first version took the payee's name, email, salary AND address as
     * request-body fields and checked exactly one thing: that the caller was on
     * the account. It then admitted under `self`, which skips every refusal
     * `admit` has — the raiser-is-not-redeemer negative and the email positive
     * both. **So one authenticated call produced an active, immediately payable
     * roster entry bearing somebody else's name and the CALLER's address,
     * repeatably, at any amount.** Reproduced by audit the turn it shipped:
     * three fabricated payees, all paying one address, suite green.
     *
     * That is the same attack at a strictly lower price — no mailbox, no
     * registration, no token, no second sign-in — reached through the very flow
     * that was cited as the safe alternative to it. **A door built to remove an
     * exception became the exception with a route in front of it.**
     *
     * Two things hold it now. **The record is about the CALLER**, because
     * everything identifying on it is read off their own sign-in and never off
     * the body — the email when they have one (`null` when they do not), and
     * the sign-in itself, which lands on the entry as `handedOverBy`. And one
     * payable entry per person: a second call cannot mint a second payee under
     * the same identity, whichever of the two identifies them.
     */
    const me = this.store.getUser(userId);
    if (!me) throw new Error('that sign-in no longer exists');
    /*
     * **A WALLET SIGN-IN CAN BE MADE PAYABLE, AND THIS IS WHERE IT CHANGED.**
     * It used to refuse here, and the refusal was right at the time: this
     * route's whole defence is that the record is unavoidably about the CALLER,
     * and the only thing making it so used to be an email read off their
     * sign-in. A wallet sign-in has none — **and there is no other kind of
     * sign-in, so `me.email` is null on every caller that reaches this door.**
     *
     * **THE EMPTY STRING IS STILL REFUSED, AND IT IS NOT REFUSED HERE — THERE
     * IS NOWHERE LEFT TO WRITE ONE.** A test pins that a blank inverts the cap:
     * an empty email compares equal to another empty one, so two people read as
     * one person and one person reads as somebody else. The fix is not a check,
     * it is the TYPE: `RosterEmployee.email` is `string | null`, `null` means
     * *nothing ever asked them for one*, and `admit`'s cap never compares two
     * absences.
     *
     * **SO WHAT IDENTIFIES THE PERSON INSTEAD, AND WHY IT CANNOT BE TWO
     * PEOPLE.** The user's own row. A `User` is created once per credential.
     * This used to name two halves — `register` refusing a second row for one
     * email address, and a wallet sign-in finding its row by
     * `getUserByWalletKey`. **The first half went with the password, and the
     * surviving half is the stronger one:** `getUserByWalletKey` is `sha256` of
     * the subwallet address the signature was verified against, and **only
     * somebody holding that subwallet's spending key can produce a signature
     * that resolves to that row**, so one id is never two people. The email
     * half rested on a uniqueness check; this one rests on a key nobody else
     * has.
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
     * ordinary invite path reached the same outcome with the cap skipped.
     */
    const { employee, raw } = this.raise(
      /* The email is the caller's own, whatever the body said — and `null`
       * when they signed in with their wallet, which is a fact about them and
       * not a blank standing in for one. */
      accountId, { ...spec, email: me.email }, viewingKey, userId);
    /*
     * The token never leaves this method. It exists because the roster entry and
     * the drop box are built by the same code either way; what is different is
     * that nobody is being asked to prove anything, because nobody else is
     * involved.
     */
    /*
     * **THIS DOOR SEALS ON OUR SIDE, AND THAT IS NOT THE OLD HAZARD
     * RETURNING.**
     *
     * That hazard is an address travelling to us in a request body. Here there
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
          /* A member's own key is worked out from the company's address now. */
          keyFrom: companyAddressForOffer(this.store, accountId),
          /*
           * **NO CODE, BECAUSE THERE IS NOBODY TO COMPARE ONE WITH.**
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
     * THE SAME `admit`, WITH THE SAME CHECKS. No bypass — a bypass here once
     * let an active payable entry be created under anybody's name for one POST.
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
   * The employee's own device hands over what it made.
   *
   * NO VIEWING KEY IS REQUIRED, and that is the point: an employee must never
   * hold the company's key. So they cannot write into the sealed roster, and
   * what they hand over goes into the account's DROP BOX — sealed to a public
   * key whose secret only a viewing-key holder can derive. `admit` folds it in.
   *
   * **The address is produced here or not at all**, on the invite path — and
   * `addSelfAsPayee` is the one other place a payee address enters, where the
   * caller and the payee are the same person by construction rather than by
   * assertion. Nowhere can an operator supply an address for SOMEBODY ELSE.
   *
   * They stay `pending` until an admin admits them. That step is not ceremony:
   * an address on file is not the same as somebody who can reach what is sent
   * to it, and a payment settles irreversibly the moment it lands.
   */
  /*
   * **THERE IS NOWHERE HERE TO PUT A PLAIN ADDRESS, AND THAT IS THE WHOLE OF
   * THE FIX.**
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
   * forget a rule it has no argument for, and a deliberate defect
   * puts the plain address back at the route — which is the only place it could
   * be added — and names the test that dies.
   */
  /**
   * **THE ONE PLACE AN INVITATION IS JUDGED READABLE, AND IT IS WHERE THE OFFER
   * IS READ RATHER THAN WHERE IT IS SHOWN.**
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
   * **IT FAILS CLOSED ON A MISSING DEADLINE.** An invitation with no
   * `expiresAt` predates the field and cannot acquire one — no migration can
   * invent when an offer was meant to lapse — and §9 refuses an invitation
   * without an expiry by name. So it is refused, with the exit said out loud,
   * in the shape every other exit here takes: not knowing is precisely when to
   * refuse.
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
   * **AN ADMIN TAKES AN INVITATION BACK.**
   * `docs/scope-invitations.md` §8.
   *
   * A hire falls through after the link has been sent and until now there was
   * nothing to do about it: the link kept working and whoever held it could
   * still set the address a salary is paid to. This is addressed by the PERSON
   * rather than by the token, because the admin does not hold the token —
   * `invite()` hands it back once, to the browser that raised it, and no route
   * gives it out again.
   *
   * **IT DOES ONE THING.** The roster entry is not touched: withdrawing the
   * PERSON is `setStatus`, it is a separate control on the same row, and the
   * lifecycle §8 describes is explicitly not this method's. What this does is
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
    /** Who is redeeming it. The route is authenticated so this is never guessed. */
    byUserId: string | null = null,
  ): SealedEmployee {
    /* Expired and revoked are refused HERE, not only on the screen
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
     * **NOTHING IS REFUSED HERE FOR A REUSED SUBWALLET.**
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
       * **TWO ENVELOPES, ONE KEY, AND THE OUTER ONE IS OURS.**
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
     * like hygiene — one standing copy of a salary rather than two. But a
     * handover can be REFUSED, and the refusal PUTS THE INVITATION BACK so the
     * person can hand over again from the right sign-in. Dropping the offer
     * here made that retry a blank screen: the invite reopens and `offerFor`
     * throws for the rest of its life, because only the holder of the raw token
     * could re-seal it and we do not hold it. **A put-back that restores half
     * of what it took is a half-fix, and this project has shipped one before.**
     */
    this.store.putInvite(invite);
    return this.store.getEmployee(employee.id)!;
  }

  /**
   * WHAT THE PERSON HOLDING THIS TOKEN IS BEING OFFERED.
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
    /** Null when no chain has given this company an address. */
    companyAddress: string | null;
    /** What the invitee's own browser seals the handover to. */
    inboxPublicKey: Hex;
    name: string; title: string; email: string;
    asset: AssetId; baseAmount: bigint; startDate: string;
    /**
     * **Beside the sealed offer rather than inside it**, because it was
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
    /** Which admin is doing this. Recorded on the roster entry. */
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
     * **THE OUTER ENVELOPE IS OURS AND THE INNER ONE IS THE INVITEE'S.**
     * One key opens both; `openHandover` checks the inner shape rather than
     * casting it, because what comes out of an envelope is JSON.
     */
    const box = openFromInbox<{
      byUserId?: string | null; handover: SealedHandover;
    }>(rec.inbox, rec.accountId, viewingKey);
    const handover = openHandover(box.handover, rec.accountId, viewingKey);

    /*
     * THE PERSON WHO RAISED THE INVITE MAY NEVER BE THE PERSON WHO REDEEMED IT.
     * With no exception — decided 17 Aug.
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
     * `acceptedBy`, a missing invite record — which is the lesson from the same
     * day, one file over: **a guard whose failure mode is to disable itself is
     * not a guard.** Not knowing who set the address of record is precisely
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
     * EVERY REFUSAL PUTS THE HANDOVER BACK. Found by audit 17 Aug, and it is
     * the fourth time this shape has been paid for.
     *
     * The put-back was wired to ONE of this method's five refusals — the email
     * mismatch — because that was the one being fixed. The other four left the
     * drop box full and the invite spent, and **there is no route that re-opens
     * an invite or empties a box.** A run refuses to build while anybody is
     * `pending`, so any one of them froze the WHOLE account's payroll behind
     * one person, permanently.
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
       * **A WITHDRAWN INVITATION CANNOT BE ADMITTED, AND THIS IS THE THIRD
       * PLACE IT IS ENFORCED ON PURPOSE.** `docs/scope-invitations.md` §8.
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
       * ITS OWN STATE.
       *
       * This used to share a message with "we do not know who redeemed it",
       * which is a different situation with a different remedy — and the
       * remedy it offered, *"re-invite them"*, mints a SECOND pending entry
       * beside the first and freezes the account twice. `createdBy` arrived
       * later; every invite written before it is missing this field permanently
       * and no migration can invent it. So it is refused, and the only exit
       * that actually works is said out loud.
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
       * never stopped the attack — an operator can type their own address as
       * the employee's either way, and the sockpuppet costs one free
       * registration.
       *
       * **What it cost:** a second flow, so a founder could get on their own
       * payroll. That flow became a hole of its own — an active, immediately
       * payable entry under anybody's name for the price of one POST, which is
       * cheaper than the attack this refusal was slowing down. **A guard whose
       * price is a parallel authorisation surface is not worth a speed bump**,
       * and this repo's history says authorisation complexity is where the
       * money holes live.
       *
       * The information is not lost, only the refusal: it lands on the roster
       * entry as `selfRaised`, where an admin reviewing can see it.
       */

      /*
       * **THE POSITIVE, AND THE ONE THAT USED TO BE HERE IS DELETED.**
       * `docs/how-money-can-be-lost.md` `C21`.
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
       * admit: every refusal passed. Reproduced end to end by audit.
       *
       * **AND IT HAD STOPPED LETTING ANYBODY BE HIRED AT ALL.** The password
       * was deleted, so a real invitee signs in with a wallet and a wallet
       * sign-in carries no email — which this comparison read as *there is
       * nothing to check them against* and refused. A check that refuses every
       * real person and passes the operator attacking them is not a weak check;
       * it is one pointing the wrong way.
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
       * Found by audit 17 Aug — and it is the price the raiser refusal had been
       * quietly paying.
       *
       * This cap lived in `addSelfAsPayee` alone. `admit` never consulted it,
       * so once the raiser refusal was removed a member could raise an ordinary
       * employee invite carrying **their own sign-in email** under any name and
       * any salary, redeem it themselves, admit, and repeat — every refusal
       * passing, because the only positive asks whether the redeemer is the
       * email on the record and the record says the member. **Reproduced by the
       * audit: three payees, one address, £27,000, suite green.**
       *
       * Here it covers both doors, because both come through `admit`.
       */
      /*
       * **WHAT THE CAP KEYS ON, AND WHY IT CANNOT BE TWO PEOPLE.**
       * `docs/NEXT.md` X8 §3.
       *
       * It keyed on the email alone, which cannot serve somebody who has none —
       * and a test pins that the obvious repair, a blank, INVERTS it: two
       * absences compare equal, so every wallet-signed-in person on an account
       * would read as the same person, and none of them as themselves.
       *
       * **SO IT KEYS ON THE PERSON, AND A PERSON IS THE SIGN-IN THAT SET THE
       * ADDRESS.** `handedOverBy` is that sign-in, sealed onto the entry at
       * this very step, and it is the payee on both doors by construction: on
       * the self path the caller IS the payee, and on the invite path the
       * positive check below refuses a redeemer who is not the person the
       * company addressed.
       *
       * **WHY ONE ID IS NEVER TWO PEOPLE.** A `User` row is created once per
       * credential. This used to rest on two halves; `register` went with the
       * password, and with it the refusal of a second row for one email, **and
       * the half that remains is the one that never needed a check**: a wallet
       * sign-in resolves to its row by `sha256` of the address the signature
       * was verified against, which only the holder of that subwallet's
       * spending key can produce.
       *
       * **AND THE EMAIL IS STILL A KEY, FOR THE ROWS THAT PREDATE THE OTHER
       * ONE.** `handedOverBy` arrived later; every entry admitted before it
       * carries `null` there for ever and no migration can invent one. The two
       * are not two spellings of one fact that could disagree — they are two
       * ways of RECOGNISING the same person, and either one matching is a
       * clash. **A cap that fires on more is never the failure; a cap that
       * fires on less is one person paid twice.** Both absences are guarded, so
       * no two nulls and no two blanks ever meet.
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
         * IN THIS PRODUCT CAN.** Found by a product-copy pass, by reading every
         * writer of a roster address rather than the message.
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
         * **AND THAT IS THE TWO-FINGERPRINTS COST, SAID WHERE IT IS PAID.** One
         * person holds one address, so changing how somebody is paid is a
         * re-admission rather than an edit, and their payslips before and after
         * sit under two `addressFingerprint` values, which is answered in
         * `a-payroll-run-is-always-private.test.ts` §5b.
         */
        throw new Error(
          `${person.email ?? 'the person who signed in to set this address'} is already `
          + 'payable on this account. One person gets one payable record, because two '
          + 'records is two salaries. To pay them at a different address, mark the existing '
          + 'record a leaver and add them again.');
      }

      /*
       * **A RECORD WITH NO EMAIL IS ONE THE PAYEE MADE FOR THEMSELVES, AND ITS
       * POSITIVE IS A DIFFERENT SENTENCE.**
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
       * **AND IT IS NOT THE DELETED COMPARISON WEARING A HAT.** It
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
       * IS WRITTEN.** `docs/scope-invitations.md` §5.
       *
       * The invitee's wallet shows a code for the address it is about to
       * disclose; they paste it into the join screen; it travels SEALED inside
       * the handover, because a fingerprint is a hundred bits that identify one
       * address and so is a standing handle on where somebody is paid. Here the
       * same code is computed from the address that ACTUALLY ARRIVED. **Two
       * codes, both derived from an address and from nothing else.**
       *
       * **WHY THIS IS NOT THE OLD HAZARD RETURNING BY A SIDE DOOR.** §5's rule
       * is that the fingerprint an ADMIN reads is computed on the admin's
       * machine, and it still is — `src/web/accepted-address.ts`, against
       * ciphertext from a route that has nowhere to put a key. This is not that
       * screen. It is `admit`, which has held the opened handover and rebuilt
       * the address through the decode below because it is the step that writes
       * the address onto the roster. Hashing a value already in this scope
       * gives this service nothing it did not have on the line below.
       *
       * **WHAT IT MAKES IMPOSSIBLE.** A page that took the person's approval
       * and sealed somebody ELSE'S address: every other check passes, the
       * envelope is well formed, the roster entry is right in every field — and
       * the code cannot be recomputed without the wallet, so it does not match
       * and nobody becomes payable. That mismatch used to reach a screen, and
       * an admin who clicked admit anyway was obeyed.
       *
       * **WHAT IT DOES NOT PROVE, AND THAT IS UNCHANGED:** somebody accepting
       * their own invitation pastes their own matching code. The codes agreeing
       * means the address that arrived is the one the wallet showed. It has
       * never meant the right person was invited.
       *
       * **`null` IS NOT A MISMATCH.** `addSelfAsPayee` walks this shape with no
       * page, no second party and nothing to confirm, and a drop box sealed
       * before the field existed carries none either. A blank standing in for a
       * code would repeat the same lesson — two absences that compare equal —
       * so the screen says *no code was given* and the admin confirms another
       * way. **This is absence, not disagreement**, and it is the one door in
       * this product that can produce it.
       */
      if (handover.confirmation !== null) {
        /* A string that is not address-shaped cannot have a code, and refusing
         * it HERE is recoverable where `payeeOf()` further down would throw
         * past the put-back and strand the drop box. */
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
     * never one address cannot get in by being well formed.
     *
     * **`payeeOf` RATHER THAN `payeeAddress`, AND IT IS THE SAME DECODE.** The
     * kind is READ off the string the wallet produced rather than asked for, so
     * this door admits a public address without anybody choosing anything.
     * Every check `payeeAddress` made is still made: the platform's Bech32m
     * checksum, the address type, and the network. What changed is that two
     * types are payees instead of one, and a third is still refused naming
     * both.
     *
     * **THE EMPLOYEE IS NOT EXPOSED BY THIS DOOR OPENING.** `payrollPayee`
     * refuses a public payee where a run is drawn and where its payment facts
     * are built, so being on the roster is not being payable from a payroll.
     */
    const address = payeeOf(handover.address, this.network);

    /*
     * **THE ADDRESS THE PAYSLIP KEY CAME FROM IS ONE OF THIS COMPANY'S.** Every
     * payslip sealed to this person will name it, and their page asks their
     * wallet for it, so an address that is not this company's would send them,
     * and every colleague whose page lists this company's addresses, to ask
     * their wallet about somebody else's contract. It is taken when it is the
     * company's address now or one this company's payslips already name;
     * otherwise refused and the invitation put back, and accepting again works
     * the key out from the address the company has now.
     */
    const companyNow = companyAddressForOffer(this.store, rec.accountId);
    if (handover.keyFrom && handover.keyFrom !== companyNow
      && !this.payslipAddressesNamedBy(rec.accountId).has(handover.keyFrom)) {
      putBack();
      throw new Error(
        `the key this person handed over was worked out from company address ${handover.keyFrom}, `
        + 'which is not this company\'s address and is named by none of its payslips. Every payslip '
        + 'sealed to them would send them to that address to open it. It has been refused and the '
        + 'invitation put back; ask them to accept again from their invitation link.');
    }

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
        /*
         * Which company address the key was worked out from, as the payee's
         * own device said. A handover that does not say is taken to be the
         * company's address now: every key derived before a company first
         * moves was derived from that address.
         */
        payslipKeyFrom: handover.keyFrom ?? companyNow,
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
    /* And the delivery drops what it was still holding. **Nothing was
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
   * /api/demo/seed` is authenticated and nothing more, and `seedDemo` calls
   * this eight times. So the product can mint roster entries that are `active`,
   * carry a well-formed address, and pass every check in `paymentFactsFor` —
   * while **nobody on earth holds the spending key for them.** The only thing
   * between that and lost money today is that the server still runs
   * `SimulatedLedger`. That needs to be refusable by construction rather than
   * by a comment.
   */
  /**
   * **A PAYEE IS HIRED IN SOMETHING THEY CAN BE PAID IN.** Every payment out of
   * a company here is made on Midnight, privately or publicly. A person hired
   * in an asset with no form on Midnight at all would be accepted, invited and
   * admitted, and then refused on the day their first payment is raised, after
   * they had handed over their address and been told they are on the roster.
   * So the refusal is here, at the doors that put somebody on the roster, in
   * the words the asset gives for itself.
   *
   * An asset with a public form only is still taken: the roster also holds
   * payees who are paid publicly, such as a supplier or the company's own
   * account, and a payroll run refuses a public payee by itself. The seeded
   * walk-through is not a door a person comes in by and does not pass here.
   */
  private refuseAPayeeWhoCannotBePaid(spec: HireSpec): void {
    const asset = this.assets.require(spec.asset);
    const privately = ledgerFormOf(asset, 'shielded');
    const publicly = ledgerFormOf(asset, 'unshielded');
    if (privately.of !== 'token' && publicly.of !== 'token') {
      throw new Error(
        `nobody can be hired in ${asset.code}. ${privately.why} Choose a currency that can be paid `
        + 'out here.');
    }
  }

  hireDirect(accountId: string, spec: HireSpec, viewingKey: Hex): { employee: RosterEmployee; secret: EmployeeSecret } {
    /*
     * **THE SEED WALKS THE INVITE PATH, SO IT NEEDS WHAT THE INVITE PATH
     * NEEDS.**
     *
     * `HireSpec.email` became nullable for `addSelfAsPayee`, and this helper
     * builds the seeded person a SIGN-IN of their own — which is an email
     * account, because `admit` checks a redeemer against the email the company
     * addressed. A null here would put an empty string in a user row and hand
     * every other blank row the same identity, which is the one thing the
     * keying rule is written against. Refused by name rather than coerced.
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
     * IT.**
     *
     * This line used to be `newWrappingKeypair()` — thirty-two random bytes,
     * handed back once, recomputable by nobody. **The seed is the only place in
     * this product that produces an employee's payslip key**, and it now
     * produces one the person can work out again on any device from the words
     * alone. `payslip-key.ts` argues the derivation; this is its one caller in
     * product code.
     *
     * **THE DISHONESTY OF THE SEED IS UNCHANGED AND IS NOT THIS METHOD'S.** The
     * words are minted HERE, on the employer's server, so the employer holds
     * them — which is exactly what `invite()` exists to prevent and what the
     * hazard above is about. A real employee's wallet is theirs and its words
     * never reach us; only `wrappingPublicKey` does. What the seed buys is that
     * the whole flow can be walked without eight browsers.
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
     * as the person the company said it was hiring. A seed that skipped that
     * would build roster entries the product cannot produce, and every test
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
       * prevent, reintroduced ten lines away by the seed.
       */
      id: 'usr_' + nanoid(12),
      email,
      /*
       * NOT `spec.name`. The name on a company's roster is the COMPANY's record
       * and is sealed; the name on a person's own account is theirs and is not.
       * Copying one into the other puts a sealed value in an unsealed table,
       * which is the failure exactly — seal one place, leak it into another.
       */
      name: email,
      /* `authHash: ''` and `authSalt: ''` were here, and the empty
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
          /* The seed's dishonesty is unchanged and is not this method's to fix:
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

  /* ---------------- sealing the roster ---------------- */

  /**
   * Seals a roster entry. The only way one reaches the store.
   *
   * `id` and `accountId` stay outside the envelope so a record can be found
   * without opening it; everything a person would call private goes inside.
   */
  /**
   * REFUSES A KEY THAT IS NOT THIS ACCOUNT'S, BEFORE ANYTHING IS SEALED WITH
   * IT. Found by audit 17 Aug.
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
   * AS ONE THAT WENT IN.**
   *
   * `openRecord` returns JSON. `PayeeAddress` is a BRANDED type whose brand is
   * a compile-time symbol, so the object that comes back type-checks as one and
   * **is not one**: it is whatever fields were sealed, revived. `payee-address.ts`
   * says there is *"deliberately no way to make a `PayeeAddress` that skipped"*
   * the parse, and across this boundary that had quietly stopped being true.
   *
   * **It was harmless until recently and is not any more.** Every field a
   * caller read — `bech32`, `coinPublicKey`, `encryptionPublicKey` — was in the
   * sealed record, so a revived payee behaved like a parsed one. Then `kind`
   * was added, which is not in a record sealed before it and **is the field
   * that decides which door a payment leaves by**. A roster sealed yesterday
   * would hand `buildRun` a payee with no kind.
   *
   * **The failure that would have been is loud rather than silent** — indexing
   * the details circuits by `undefined` throws where a run is BUILT, before
   * anything is approved or paid — and it is still a roster that stops working.
   * Re-parsing removes it entirely: what this returns came out of a decode, so
   * the kind is present and agrees with the bytes beside it, whenever the record
   * was written.
   *
   * **`payeeOf` RATHER THAN `payeeAddress`, AND THAT IS THE WIDENING THE
   * PREVIOUS COMMENT PROMISED.** It read `payeeAddress` and said *the day the
   * roster learns about public payees, this line widens deliberately and
   * `RosterEmployee.address` widens with it.* This is that day, and both moved
   * together rather than one of them being noticed later.
   *
   * **A RECORD SEALED BEFORE THIS CHANGE IS UNAFFECTED, AND IT IS PINNED
   * RATHER THAN ASSERTED.** A `shield-addr` through `payeeOf` returns the
   * shielded kind, because the kind comes from the type segment the platform
   * put in the string; and the seal already carries the bech32 and the network
   * this line re-parses.
   *
   * **TWO FIXTURES, BECAUSE THERE ARE TWO OLD SHAPES AND ONE COMMENT CLAIMING
   * BOTH WOULD BE HALF FALSE.** `a-payroll-run-is-always-private.test.ts` §4
   * seals a record from before the widening, which HAS a `kind` because `kind`
   * came first; `core.test.ts`'s *A ROSTER ADDRESS SEALED WITHOUT A KIND COMES
   * BACK WITH ONE* seals one from before `kind`, which has none. The stored
   * `kind` is thrown away either way: everything below is rebuilt from
   * `bech32`.
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
   * **IS THERE SOMETHING WAITING TO BE ADMITTED FOR THIS PERSON?**
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
   * `docs/scope-invitations.md` §5,
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
   * **NOTHING WAS EVER PAID THAT WAY**: a run refuses by name for a person with
   * no address (`payroll.ts`, *"has no address. It has to come from their own
   * device or wallet"*), so the hole was caught downstream and money was safe.
   * That is why this is not a money hole, and it is recorded as not being one.
   * It is still a door that answers *yes* to a question only `admit` may
   * answer, and the control that does it properly is being built elsewhere — so
   * this is the same turn to close the door beside it.
   *
   * **`leaver` IS UNGUARDED AND MUST STAY THAT WAY.** Withdrawing a pending
   * person is the only exit from an invitation that can never be admitted
   *, and a guard here would strand exactly the people that exit exists
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

  /**
   * Draws a run from the active roster rather than an ad hoc list.
   *
   * ── WHO A PENDING PERSON FREEZES, AND IT USED TO BE EVERYBODY ────────────
   *
   * **THE SKIP ALREADY EXISTED.** The roster below is built from
   * `status === 'active'` only, so a pending person never reaches a payslip
   * whatever happens here. **The pre-flight threw in front of that filter**, so
   * the effect of one unaccepted invitation was that nobody in the company was
   * paid — and the right question to ask about it is: why should an
   * employee who has been sent an invite be able to freeze the entire payroll?
   *
   * **THE ARGUMENT THE OLD REFUSAL WAS BUILT ON IS HALF RIGHT AND IS KEPT.** Its
   * own comment: *silently escrowing someone's salary data because they have not
   * set up yet is worse than a delay.* **That failure mode is real** — the person
   * who quietly does not appear on payday is the person nobody notices, and a
   * missing salary discovered a month later is a month of somebody's rent.
   * **What was wrong was the remedy: it chose REFUSE EVERYONE over TELL
   * SOMEBODY.** So the block becomes a confirmation. It still refuses by
   * default, it still names them, and it now says which of the two things is
   * wrong with each — but an admin who has read that can proceed, and what they
   * proceeded with is written down (`skips`, `run-skips.ts`).
   *
   * **AND THE PART THAT WAS A DEFECT RATHER THAN A BLUNT POLICY: the pending set
   * was computed over EVERYBODY and computed BEFORE `employeeIds` was applied.**
   * An admin naming five fully-admitted people was refused because a sixth,
   * unrelated, unnamed person had an invitation open. That was a check standing
   * in the wrong place, not a rule, and moving it is most of this change.
   *
   * **WHAT THIS DOES NOT DO.** It does not get a pending person paid, and it
   * must not be read as having. Somebody who cannot complete acceptance stays
   * unpaid; what changes is that their colleagues do not. The freeze was the
   * amplifier and the front door is the defect.
   */
  async createRunFromRoster(
    accountId: string,
    period: string,
    viewingKey: Hex,
    employeeIds?: string[],
    /**
     * Absent means REFUSE, and absent is the default on every existing caller.
     * Nobody is left out of a payroll run by a value nobody supplied.
     */
    skipPending?: SkipAcknowledgement,
  ) {
    /*
     * **THE PERIOD IS READ BEFORE ANYTHING IS ASKED ABOUT IT.** The two
     * refusals below select the runs they compare against by period, and the
     * run this draws is written down under one, so a period that reached them
     * as typed would put a second payroll for the same month beside the first.
     * Reassigned rather than bound beside it, so a line added here later cannot
     * pick up the raw one.
     */
    period = canonicalPeriod(period);
    const all = this.listPeople(accountId, viewingKey);

    /*
     * **THE SUBSET FIRST, AND EVERY QUESTION AFTER THIS ONE IS ASKED ABOUT IT.**
     *
     * `employeeIds` is what an admin says when they mean *pay these five*. The
     * pending set, the refusal, the names in it and the record of who was left
     * out are all drawn from `asked` and never from `all` — because a run is
     * only ever refused, or excused, over the people it was actually trying to
     * pay. **One list, computed once**: the filter below reuses it rather than
     * asking `all` a second time, so a subset the refusal was computed over and
     * a subset the roster is drawn from cannot come apart.
     */
    const asked = all.filter(e => !employeeIds || employeeIds.includes(e.id));

    // Pre-flight. Refusing by default is still the right call: silently
    // escrowing someone's salary data because they have not set up yet is worse
    // than a delay. What an admin gets now is a way to say they have read it.
    /*
     * TWO PENDING STATES, NAMED SEPARATELY: "outstanding" that covers two
     * different situations is how an operator stops looking. Somebody who has
     * handed nothing over is waiting on THEM; somebody whose drop box is full
     * is waiting on US.
     */
    const pending = asked.filter(e => e.status === 'pending');
    /*
     * **THE PEOPLE, NOT THE INDEX.** The index is minted in `createRun`,
     * because a register names the run it belongs to (`run-skips.ts`,
     * `emptyRegister`) and the run has no id until it is built. **A stand-in id
     * was considered and refused**: `registerFor` exists to refuse a register
     * raised for a different run, and an id this method invented is a value
     * that comparison could never be right about.
     */
    let leftOut: RunSkip[] | undefined;
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
      const named = parts.join('; ');

      /*
       * **THE DEFAULT REFUSES. THAT IS THE PROPERTY, NOT THE ERGONOMICS.**
       *
       * Everything below this line — the acknowledgement, the name comparison,
       * the record — exists so that an admin can proceed DELIBERATELY. Nothing
       * exists so that a run can proceed by itself. A caller that passes
       * nothing is refused, which is every caller that existed before this
       * round and every caller that forgets.
       */
      if (!skipPending) {
        throw new Error(
          `payroll cannot run without leaving somebody out: ${named}. `
          + 'Admit them and run again, or confirm this run goes ahead without them — '
          + 'which needs their names, yours, and a reason, so that a month from now the '
          + 'record says who was not paid and who decided that.');
      }

      /*
       * **THE ACKNOWLEDGEMENT IS ABOUT THESE PEOPLE OR IT IS ABOUT NOBODY.**
       *
       * Both directions are refused and they are different failures. A pending
       * person the admin did NOT name is somebody dropped without being read —
       * the exact thing the old wall was there to stop, arriving through the
       * way this change opens. A name the admin DID give who is not being
       * skipped means the list they were shown has moved since they read it:
       * somebody was admitted, withdrawn, or the run is over a different subset.
       * **In that case their agreement is about a different payroll, and
       * treating it as agreement to this one is putting words in their mouth.**
       */
      const acknowledged = new Set(skipPending.employeeIds);
      const unnamed = pending.filter(e => !acknowledged.has(e.id));
      const wouldSkip = new Set(pending.map(e => e.id));
      const notSkipped = skipPending.employeeIds.filter(id => !wouldSkip.has(id));
      if (unnamed.length) {
        throw new Error(
          `this run would also leave out ${unnamed.map(e => e.name).join(', ')}, `
          + 'who is not in what was confirmed. Nobody a run is drawn over is left out of it '
          + 'without being named, so read the list again and confirm the whole of it, or '
          + 'admit them.');
      }
      if (notSkipped.length) {
        throw new Error(
          `${notSkipped.length === 1 ? 'one of the people' : 'some of the people'} confirmed as `
          + 'being left out is not being left out by this run, so the list that was read is not '
          + `the list this run would act on: ${named}. Take the confirmation again against `
          + 'what this run actually skips.');
      }

      /*
       * **WHICH HALF EACH PERSON IS IN, DECIDED ONCE, HERE.** The refusal
       * sentence above and the record below are two renderings of this one
       * partition. Asking `inbox` a second time to build the record would be a
       * second split that could disagree with the first — and the way it would
       * disagree is that somebody's report says an admin is holding them up
       * when nobody is.
       */
      leftOut = pending.map((e): RunSkip => ({
        employeeId: e.id,
        name: e.name,
        waiting: waitingOnUs.some(u => u.id === e.id) ? 'us' : 'them',
      }));
    }

    const roster = asked.filter(e => e.status === 'active');
    if (roster.length === 0) {
      throw new Error(leftOut
        ? 'there is nobody left to pay: everybody this run was drawn over is still pending, so '
          + 'confirming that they are left out leaves the run empty. Admit somebody first.'
        : 'no active employees to pay');
    }
    /*
     * **A PAYROLL RUN IS ALWAYS PRIVATE, ASKED HERE AS WELL AS AT THE MONEY.**
     * `movement.ts`.
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
    if (this.store.listRuns(accountId)
      .some(r => samePeriod(r.period, period) && r.status !== 'draft')) {
      /*
       * **AND IT NAMES WHAT TO DO INSTEAD, BECAUSE OF WHO READS IT.** This is
       * the refusal a person meets when they type the month again after a raise
       * they did not get an answer to, and the answer they need is that the run
       * they are trying to recreate is the one to raise again.
       */
      throw new Error(
        `a run for ${period} already exists. If that is the run you meant and its raise failed, `
        + 'raise that run again unchanged rather than drawing this payroll up a second time: it '
        + 'keeps its people\'s payment secrets, so raising it again cannot pay anybody twice. If '
        + 'some of the people on it were not reached, raise a retry on it for them.');
    }
    /*
     * **AND A DRAFT IS NOT ALWAYS A DRAFT.** A run stays `draft` until its raise
     * returns, and a raise can throw after the network has the transaction - so
     * the run that failed, and that somebody is now pressing the button again
     * about, may be on chain. The status alone cannot say; the proposal records
     * can, because they are written before the chain is called.
     */
    this.refuseAPayrollThatMayBeOnChain(accountId, period, viewingKey);
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
      /*
       * **THE PEOPLE AND THE ACKNOWLEDGEMENT TRAVEL TOGETHER, OR NEITHER
       * DOES.** `createRun` mints the index only when it has both, so there
       * is no path on which a run carries a list of unpaid people with nobody's
       * name against it. `skipPending` is non-null wherever `leftOut` is: the
       * only branch that sets `leftOut` has already refused an absent one.
       */
      leftOut && skipPending ? { people: leftOut, ack: skipPending } : undefined,
    );
  }

  /**
   * WHAT THE CHAIN NEEDS, BUILT FROM THE ROSTER AND FROM NOTHING ELSE.
   *
   * This is the function that did not exist, and its absence is why a payee was
   * still "32 bytes somebody typed": nothing in this repo turned a roster into
   * `PaymentFacts`, so the only way to get them was to write them by hand.
   *
   * **There is no parameter here through which an address could be supplied.**
   * Each one comes from the payee's own sealed roster entry, which they put
   * there themselves.
   *
   * **THE RULE IS ENFORCED HERE RATHER THAN ASSUMED.** Three refusals, each
   * naming the person and what is actually wrong, because a payment settles
   * irreversibly the moment it lands and the failure it produces — money in an
   * address whose secrets nobody holds — is not recoverable by anybody.
   */
  /*
   * **`ShieldedPaymentFacts`, AND THE NARROWING IS THE POINT.**
   *
   * A vault holds both kinds of money and `payout-tree.ts` carries the kind per
   * payee. **This path produces private ones only**, and that is still true
   * after the widening — but it is true for a DIFFERENT REASON than it was, and
   * the difference is the whole point.
   *
   * **IT USED TO BE TRUE BY ACCIDENT.** A roster address arrived through
   * `payeeAddress`, which refused anything but a `shield-addr`, so no public
   * payee could exist to reach this line. The narrowing held because the door
   * upstream was shut.
   *
   * **THE DOOR IS OPEN NOW AND THE NARROWING IS HELD BY A RULE.** A
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
  paymentFactsFor(
    runId: string, viewingKey: Hex,
    /**
     * **WHICH SETTLEMENT LEG, OR THE WHOLE RUN.**
     *
     * A run is approved and paid one asset at a time, so the facts that go into
     * a tree are one leg's. Omitted, this answers for the whole run, which is
     * what a caller checking that everybody on the payroll can be paid wants and
     * is NOT what a caller building a run's material wants.
     */
    asset?: AssetId,
  ): ShieldedPaymentFacts[] {
    const run = this.requireRun(runId, viewingKey);
    const people = asset === undefined ? run.employees : legEmployees(run, asset);
    return people.map((e) => {
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
      /*
       * **THE TOKEN IS THE LEDGER'S, IN THE FORM THIS PAYEE IS PAID IN, READ OFF
       * THE ASSET'S ROW.** A vault pays out of the token a payment names, so a
       * payment naming its money by the account's name for the asset would be
       * approved, paid for, and refused at the vault. Where the asset has no
       * private form this refuses now, before any material is built or any fee
       * is spent, and says which assets can be paid privately.
       */
      const payee = payrollPayee(person.name, person.address);
      return {
        payee,
        token: ledgerTokenOf(e.asset, payee.kind, this.assets),
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
    /**
     * **WHO THIS RUN IS DELIBERATELY NOT PAYING, AND WHO SAID SO.**
     *
     * Drawn by `createRunFromRoster`, which is the only caller that can know:
     * an ad hoc run has no roster to be pending on. The index is minted
     * here rather than there because a register names the run it belongs to and
     * the id is minted below.
     */
    leftOut?: { people: RunSkip[]; ack: SkipAcknowledgement },
    /**
     * **WHICH EARLIER RUNS FOR THIS PERIOD THIS ONE KNOWINGLY REPEATS, AND WHO
     * SAID SO.** Absent means a repeat is REFUSED, and absent is the default on
     * every caller. See `RepeatAcknowledgement`.
     */
    repeats?: RepeatAcknowledgement,
  ): Promise<{ run: PayrollRun; secrets: EmployeeSecret[] }> {
    /*
     * **EVERY RUN THIS PRODUCT DRAWS IS DRAWN HERE**, from a roster or ad hoc,
     * from either build, and from anything written later. So this is where a
     * period becomes a month rather than a typing: the value written onto the
     * run, and the value every guard downstream compares, is the one this
     * returns. Reassigned rather than bound beside it, for the reason the
     * roster door reassigns it.
     */
    period = canonicalPeriod(period);
    this.accounts.require(accountId);
    if (specs.length === 0) throw new Error('a payroll run needs at least one employee');
    /*
     * **BEFORE ANYTHING IS BUILT, BECAUSE A REPEAT NOBODY CONFIRMED IS REFUSED.**
     * Asked about every run for the period, drafts included, because this is
     * the one moment a person can say what they mean and have it written down.
     *
     * **NOT ASKED OF THE ROSTER'S OWN DRAW UNLESS IT BRINGS A CONFIRMATION.** The
     * roster draws a period's payroll and cannot take one, and a second draft of
     * it pays nobody: what stops two runs over the same people both being paid
     * is asked when a run is RAISED, where only runs already raised count. A
     * refusal here would only let a draft that can never be raised - an ad hoc
     * run over the same names - shut the roster out of the period for good.
     */
    const repeated = roster && !repeats ? undefined : acknowledgedRepeats(
      period, this.runsRepeating(accountId, period, contentOf(specs), viewingKey), repeats,
      new Date().toISOString());
    /*
     * **`runId`, NOT `id`, AND THE NAME IS THE WHOLE REASON FOR THIS COMMENT.**
     * The loop below binds its own `id` for the EMPLOYEE, and this function's
     * own history is why that matters: reading the wrong variable in that loop
     * (`roster?.[i]` as `roster?.[0]`) left 145 tests green while printing one
     * person's address on every payslip. A run id in scope under the name `id`
     * is the next round's version of that.
     */
    const runId = 'run_' + nanoid(12);
    /*
     * **BEFORE ANYTHING IS BUILT, BECAUSE `decide` CAN REFUSE.** An
     * acknowledgement with nobody's name on it or no reason in it throws here,
     * and the run that would have carried an unsigned skip is never created.
     */
    const skips = leftOut
      ? recordSkips(runId, leftOut.people, leftOut.ack, new Date().toISOString())
      : undefined;

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
         * **THE ONE PLACE LEFT THAT MINTS A PAYSLIP KEY.**
         *
         * An ad hoc run pays somebody who is not on the roster, so there is no
         * handover, no wallet and nothing to derive from — `payslipKeypairFrom`
         * would have nothing to expand. So this stays random, the secret is
         * returned once, and `words` is absent to say so in the type.
         *
         * **IT IS NOT A GAP LEFT OPEN BY OVERSIGHT.** Closing it means an ad
         * hoc payee handing over a public key first, which is an onboarding
         * flow and not a derivation — reported rather than smuggled in. Until
         * then, an ad hoc payslip is exactly the hazard described above.
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
       * THE PAYSLIP CARRIES THE ADDRESS OF RECORD.
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
       * not a defence today and must not be counted as one.**
       */
      const slipKey = newSymmetricKey();
      const slip = seal(canonical({
        employeeId: id, name: spec.name, asset: spec.asset, amount: spec.amount, period,
        paidTo: addressOf(spec, existing),
      }), slipKey);
      /*
       * **THE ADDRESS THE PAYEE ASKS THEIR WALLET FOR, WRITTEN ON THE SLIP.**
       * A roster payee's key was worked out from one company address, and
       * that is the address that opens this slip for as long as it exists,
       * whatever the company's address becomes. An ad hoc payee's key was
       * minted above and no address produces it, so there is none to name.
       */
      const issuedBy = existing
        ? (existing.payslipKeyFrom ?? companyAddressForOffer(this.store, accountId))
        : null;
      payslips.push({
        employeeId: id, wrapped: wrapKey(slipKey, publicKey), slip, issuedBy,
        /* The public key it is wrapped to, which is what its payee asks by. */
        sealedTo: publicKey.toLowerCase(),
      });
    });

    const run: PayrollRun = {
      id: runId,
      accountId,
      period,
      employees,
      payslips,
      /*
       * A SUBTOTAL PER ASSET, never one total.
       *
       * Adding 5,000 GBP to 5,000 USDC and displaying 10,000 is not an
       * approximation, it is meaningless — and the sufficiency check that used
       * that figure would have passed or failed for reasons unrelated to
       * whether the account can pay anybody.
       */
      totals: subtotals(employees.map(e => ({ asset: e.asset, amount: e.amount }))),
      proposalIds: {},
      status: 'draft',
      ...(skips ? { skips } : {}),
      ...(repeated ? { repeats: repeated } : {}),
    };
    this.putRun(run, viewingKey);
    return { run, secrets };
  }

  /**
   * Turns ONE ASSET'S worth of a run into a proposal. Individual amounts stay
   * inside the sealed payload.
   *
   * ONE PROPOSAL PER SETTLEMENT ASSET, and it was the visible consequence of
   * the contract moving one asset per round. A run that pays everybody
   * in pounds is one proposal, which is every run today. A run paying some
   * people in pounds and some in USDC is two, both referencing the same run id,
   * and both have to be paid before the run is done.
   *
   * **THE CIRCUIT THAT MOVED ONE ASSET IS GONE**, so this shape is no
   * longer forced by the chain: a proposal's change commitment still names one
   * asset key and nothing opens it. What holds the rule now is
   * `AccountService.oneAssetOf`, which refuses a mixed batch here rather than
   * at settlement.
   *
   * The alternative was a round carrying a fixed-width vector of legs, which
   * taxes every such round with the width of the widest run anybody might ever
   * make and reintroduces exactly the static cap a redeploy was spent removing.
   *
   * `asset` may be omitted only when the run has one, which keeps the common
   * case a one-argument call and makes the ambiguous case impossible to write
   * by accident.
   */
  async proposeRun(
    runId: string, viewingKey: Hex, proposedBy: string, payable: RunMaterial | null, asset?: AssetId,
    how?: { onDevice: true },
  ) {
    const run = this.requireRun(runId, viewingKey);
    const release = this.holdTheLeg(run, legOf(run, asset));
    try {
      return await this.raiseTheLeg(runId, viewingKey, proposedBy, payable, asset, how);
    } finally {
      release();
    }
  }

  /** `proposeRun`, once the leg is held. */
  private async raiseTheLeg(
    runId: string, viewingKey: Hex, proposedBy: string,
    /**
     * **THIS LEG'S PAYOUT MATERIAL — OR `null` FROM A CALLER THAT HAS NONE.**
     *
     * **NULLABLE RATHER THAN OPTIONAL, so a call site that has no run material
     * has to say so out loud instead of forgetting** — the rule this file
     * already applies to `invite`'s `createdBy`. A caller that cannot name a
     * vault, or that is seeding a company that has none, passes `null` and is
     * refused; that is the correct answer and not a gap.
     *
     * **BUILT ABOVE THIS LAYER AND HANDED DOWN, WHICH IS FORCED.** The root is a
     * merkle tree hashed the way the chain hashes, and this layer may not reach
     * the runtime that does it — that dependency rule is what keeps the browser
     * page free of the chain's WebAssembly. So the material is built where the
     * runtime is available and arrives here as a value.
     *
     * **AND IT CANNOT BE ASSEMBLED BY HAND.** Its type is obtainable only from
     * the one function that reads the root, the payee count and the leaves off a
     * single tree, because the agreement between those three is the thing this
     * door most needs and least can check.
     */
    payable: RunMaterial | null,
    asset?: AssetId,
    /**
     * **THE SIGNER'S DEVICE SENDS THE PROPOSAL.** Everything below happens
     * exactly as it does otherwise - the material and the proposal are written down - and
     * nothing is sent from this process. `raiseOrderOf` is what the device then
     * builds from.
     */
    how?: { onDevice: true }) {
    const run = this.requireRun(runId, viewingKey);
    if (run.status !== 'draft' && run.status !== 'proposed') throw new Error(`run is ${run.status}`);

    const leg = legOf(run, asset);
    this.refuseALegThatIsProposed(run, leg, viewingKey);

    const paid = legEmployees(run, leg);
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
     * **THIS CALLED `this.accounts.propose({kind: 'payroll'})` AND THAT WAS A
     * RUN THAT COULD NEVER BE PAID.**
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
     * who were meant to be paid.
     */
    if (!payable) {
      throw new Error(
        `the ${leg} leg of run ${run.id} cannot be proposed without its payout material: the ` +
          'merkle root over this leg\'s blinded payee leaves, the window it may be paid in, ' +
          'and the vault that will pay it. Those three are what a vault is presented with, and ' +
          'a round raised without them is one no vault can ever match — approved, paid for, ' +
          'and unpayable. Build the material for this leg first and raise the run with it.',
      );
    }
    if (payable.run.payees !== BigInt(paid.length)) {
      throw new Error(
        `this run pays ${paid.length} people in ${leg} and the run material names ` +
          `${payable.run.payees}. The payee count is bound into the payload the signers ` +
          'approve, so a run cannot be declared finished early or made never to finish — and a ' +
          'count that disagrees with the roster is one of the two.',
      );
    }
    /*
     * **THE LEAF LIST AND THE COUNT THE SIGNERS APPROVE ARE THE SAME NUMBER.**
     *
     * The root and the leaves are two views of one tree, and a leaf list that is
     * short by one is a person whose payment nothing will ever report on.
     */
    if (payable.run.payees !== BigInt(payable.leaves.length)) {
      throw new Error(
        `this run material names ${payable.run.payees} payees and carries ` +
          `${payable.leaves.length} payout leaves. They are two views of one tree and a run ` +
          'whose leaves do not account for its own payees cannot be reported on.',
      );
    }
    /*
     * **AND THE ROOT THE SIGNERS WILL APPROVE IS THE ROOT OVER THESE LEAVES,
     * CHECKED HERE AND NOT INFERRED FROM WHERE THE VALUE CAME FROM.**
     *
     * This is the strongest of the three agreements and it is the one that costs
     * a whole payroll: a run approved against a root that does not describe its
     * own payees is refused at every `recordPayment`, on payday, after the
     * signatures are in and the fee is spent. **The material's TYPE cannot carry
     * this** — the brand says the value was built rather than typed out, and a
     * spread carries the brand across while replacing a field — so the
     * derivation travels with the material and is called here on the values
     * actually in front of the door.
     *
     * **IT IS THE TREE BUILDER'S OWN FUNCTION AND NEVER A SECOND ONE.** A root
     * computed a second way here would build a check that agrees with itself and
     * with nothing the chain will do.
     */
    if (payable.rootOf(payable.leaves) !== payable.run.root) {
      throw new Error(
        'this run material\'s payout root is not the root over its own leaves, so the run the ' +
          'signers would approve is not the run these payees are in. Every payment against it ' +
          'would be refused as a payee who is not in the approved run, on payday, after the ' +
          'signatures were collected and the fee was spent.',
      );
    }
    /*
     * **THE MATERIAL WAS BUILT FOR THIS LEG OF THIS RUN, CHECKED AND NOT
     * ASSUMED.** Every payee's secrets are derived from the identifier below, so
     * material built under another one derives different leaves for the same
     * people. Two legs of one payroll are two runs by this measure.
     */
    const legRunId = runIdForLeg(run, leg);
    if (payable.identity.runId !== legRunId) {
      throw new Error(
        `this material was built for run ${payable.identity.runId} and is being raised for ` +
          `${legRunId}. A run's payee secrets are derived from its identifier, so material ` +
          'from another run describes other people.',
      );
    }
    if (payable.identity.accountId !== run.accountId) {
      throw new Error(
        `this material was built for account ${payable.identity.accountId} and this run ` +
          `belongs to ${run.accountId}.`,
      );
    }

    /*
     * **THE MATERIAL IS WRITTEN DOWN BEFORE THE ROUND IS RAISED, AND THE ORDER
     * IS THE POINT.**
     *
     * Every field of it is computed before the call and none of it is a function
     * of the answer, so there is nothing to wait for. What there is to lose is
     * the SEED GENERATION: a lost write after a successful raise would leave a
     * round on chain whose leaves nobody can rebuild once a signer has been
     * removed, and that is the one part of a run that cannot be reconstructed
     * from the payroll. The confirmation — which proposal this leg was raised
     * under — is the half that CAN be recovered from the chain, so it is the
     * half that is written afterwards.
     */
    /*
     * **READ, CHANGE, WRITE — WITH NOTHING AWAITED IN BETWEEN, AND THAT IS THE
     * WHOLE OF WHY THE RECORD IS RE-READ HERE.**
     *
     * `putRun` writes the run whole. The record opened at the top of this method
     * was read before any of the checks above, and a second leg of the same
     * payroll can be raised while this one is in flight — so writing that
     * snapshot back would silently drop whatever the other leg had recorded in
     * the meantime. Re-reading immediately before the change, and awaiting
     * nothing between the read and the write, makes the two legs queue instead
     * of overwrite.
     *
     * **AND THE ALREADY-PROPOSED GUARD IS ASKED AGAIN HERE**, against the record
     * as it is now rather than as it was when this call started.
     */
    /*
     * **A RUN IS NOT RAISED OVER PEOPLE ANOTHER RUN FOR THE PERIOD HAS ALREADY
     * BEEN RAISED TO PAY, UNLESS ONE OF THE TWO SAYS IT MEANS TO.** Each run
     * gives its people their own payment secrets, so nothing on chain connects
     * the two. The confirmation is written when a run is drawn up; this is
     * where it is read.
     */
    this.refuseRaisingOverAnotherRun(run, viewingKey);
    /*
     * **A LEG THAT WAS RAISED BEFORE AND NEVER HEARD BACK FROM IS RAISED AGAIN
     * AS THE SAME ROUND, NOT AS A NEW ONE.** A new round is a new salt and a new
     * id: if the first attempt landed there would be two open rounds over the
     * same people. Asked here, before the material below is written, so a
     * request describing a different round leaves the record of the earlier
     * one exactly as it was.
     */
    const again = this.earlierRoundOfLeg(run, leg, viewingKey);
    const earlierMaterial = run.payout?.[leg];
    if (again !== undefined && earlierMaterial
        && (payable.run.opensAt !== earlierMaterial.opensAt
          || payable.run.closesAt !== earlierMaterial.closesAt
          || payable.run.vault !== earlierMaterial.vault)) {
      throw new Error(
        `the ${leg} leg of run ${run.id} was raised before, may be on chain, and was raised with `
        + `the window ${earlierMaterial.opensAt} to ${earlierMaterial.closesAt} at vault `
        + `${earlierMaterial.vault}. Raising it again is raising that same round, so it takes `
        + 'that window and that vault; a different one would be a second round over the same '
        + 'people. To raise it with a different window or vault, withdraw that round first - '
        + 'withdrawing asks the chain, and a round the chain holds can be withdrawn only until its '
        + 'window opens - and raise it after.');
    }
    if (again !== undefined) {
      this.accounts.refuseRaisingADifferentRound(run.accountId, again, viewingKey, payable.run, leg);
    }

    const beforeRaising = this.requireRun(runId, viewingKey);
    this.refuseALegThatIsProposed(beforeRaising, leg, viewingKey);
    beforeRaising.payout = { ...(beforeRaising.payout ?? {}), [leg]: {
      root: payable.run.root,
      payees: payable.run.payees,
      opensAt: payable.run.opensAt,
      closesAt: payable.run.closesAt,
      vault: payable.run.vault,
      leaves: payable.leaves,
      facts: payable.facts,
      runId: payable.identity.runId,
      epoch: payable.identity.epoch,
    } };
    this.putRun(beforeRaising, viewingKey);

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
      run: payable.run,
      payments: payable.facts,
      proposedBy,
      ...(again !== undefined ? { again } : {}),
      ...(how?.onDevice ? { onDevice: true as const } : {}),
    });

    /*
     * **THE SAME READ-CHANGE-WRITE, FOR THE SAME REASON, AND THIS ONE IS THE
     * ONE THAT WAS MEASURED GOING WRONG.** Two legs raised at once both awaited
     * the chain and then wrote back the record each had read beforehand; the
     * second write dropped the first leg's proposal id, and the guard that
     * refuses a leg already proposed then read the field that had just been
     * cleared — so the same payees were raised on chain a second time, under a
     * fresh salt, with the approvals split across two rounds that neither reach
     * threshold nor can be withdrawn.
     */
    const afterRaising = this.requireRun(runId, viewingKey);
    afterRaising.status = 'proposed';
    afterRaising.proposalIds = { ...afterRaising.proposalIds, [leg]: proposal.id };
    this.putRun(afterRaising, viewingKey);
    return proposal;
  }

  /**
   * **ANOTHER ATTEMPT AT SOME OF ONE LEG'S PEOPLE, RAISED ON THE LEG IT RETRIES.**
   *
   * A leg's approved round can end without reaching everybody: its window
   * closes with people still owed, a vault runs dry part way, a device drops
   * out half way through paying. Those people are paid by a second approval
   * over a smaller tree - and the only thing that makes that safe is that each
   * of them has the SAME leaf in the smaller tree as in the first. The account
   * records a completed payment by its leaf, so whichever attempt pays a person
   * first is the only one that can.
   *
   * **SO EVERY CHECK BELOW IS ABOUT THE LEAVES BEING THE LEG'S OWN.** The
   * material must have been derived under the identity and the seed generation
   * the leg was raised under, and each of its leaves must be byte-for-byte the
   * leaf the leg already holds for that person. Material derived any other way
   * gives the same people different leaves, which are different payments, which
   * both settle.
   *
   * **THE RETRY IS WRITTEN ONTO THE LEG BEFORE IT IS RAISED**, for the reason a
   * leg's own material is: what cannot be rebuilt goes down first, and which
   * proposal it was raised as is written afterwards. A retry whose raise threw
   * is raised again as the same round, exactly as a leg is.
   *
   * **IT NAMES ONLY PEOPLE NOBODY HAS PAID AND NOTHING ELSE CAN STILL PAY, AND
   * IT IS REFUSED, NEVER NARROWED, WHEN IT NAMES ANYONE ELSE.** The account
   * would refuse a paid person's leaf a second time, so this is not what stops
   * a second payment; it is what stops a round that can never complete - a
   * second fee, a second set of approvals, and a window that, once open, cannot
   * be withdrawn. It is asked here, under the leg's hold, so two requests
   * cannot both find the same people free. See `refuseARetryOverPeopleCovered`.
   */
  async proposeRetry(
    runId: string, viewingKey: Hex, proposedBy: string, payable: RetryMaterial | null, asset?: AssetId,
    how?: { onDevice: true },
  ) {
    const run = this.requireRun(runId, viewingKey);
    const release = this.holdTheLeg(run, legOf(run, asset));
    try {
      return await this.raiseARetry(runId, viewingKey, proposedBy, payable, asset, how);
    } finally {
      release();
    }
  }

  /** `proposeRetry`, once the leg is held. */
  private async raiseARetry(
    runId: string, viewingKey: Hex, proposedBy: string,
    /**
     * **THIS ATTEMPT'S PAYOUT MATERIAL, OR `null` FROM A CALLER THAT HAS NONE.**
     * Built above this layer from the leg's own record, for the reason a leg's
     * material is.
     */
    payable: RetryMaterial | null,
    asset?: AssetId,
    /**
     * **THE SIGNER'S DEVICE SENDS THE RETRY**, exactly as it sends a leg: the
     * retry and its proposal are written down as they otherwise are, nothing is
     * sent from this process, and `retryRaiseOrderOf` is what the device builds
     * from. Every rule above and below is asked the same either way.
     */
    how?: { onDevice: true },
  ) {
    const run = this.requireRun(runId, viewingKey);
    const leg = legOf(run, asset);
    const recorded = run.payout?.[leg];
    if (!recorded || !run.proposalIds[leg]) {
      throw new Error(
        `the ${leg} leg of run ${run.id} has not been raised, so there is nobody on it to retry: a `
        + 'retry pays people an approved round did not reach, and this leg has no round yet. '
        + 'Raise the leg first.');
    }
    /*
     * **A LEG THAT NEVER REACHED THE CHAIN HAS NO ROUND TO RETRY.** A retry is
     * judged against this company's ceiling like any round, and a payroll that
     * policy stopped, split into smaller retries, would be a way round the rule
     * that stopped it. A leg the chain held and that was later withdrawn may be
     * retried, because its people keep their leaves - but only while no other run
     * for the period has been raised over them since, which is asked below: the
     * withdrawal is exactly what lets another run be raised over the same people.
     */
    const legRound = this.accounts.requireProposal(run.proposalIds[leg]!, viewingKey);
    if (!legRound.raisedAt) {
      throw new Error(
        `the ${leg} leg of run ${run.id} ${legRound.status === 'blocked'
          ? 'was stopped by this company\'s own policy'
          : 'has no round the chain has been seen to hold'}, so there is no round on it to retry. A `
        + 'retry is judged against the same rules as any round, and splitting a payroll that never '
        + 'reached the chain into smaller ones is not a way round them.');
    }
    if (!payable) {
      throw new Error(
        `a retry on the ${leg} leg of run ${run.id} cannot be raised without its payout material: `
        + 'the merkle root over the leaves of the people it pays, the window it may be paid in, '
        + 'and the vault that will pay it.');
    }
    if (payable.identity.accountId !== run.accountId
        || payable.identity.runId !== recorded.runId
        || payable.identity.epoch !== recorded.epoch) {
      throw new Error(
        `this retry was built under run ${payable.identity.runId} at seed generation `
        + `${payable.identity.epoch} for account ${payable.identity.accountId}, and the leg it `
        + `retries was raised under ${recorded.runId} at generation ${recorded.epoch} for account `
        + `${run.accountId}. A person on a retry is paid once only because their leaf is the leaf `
        + 'they already had, and material derived under any other identity gives them a different '
        + 'leaf: a second payment that nothing on chain would refuse.');
    }
    const indices = payable.originalIndices;
    if (indices.length === 0) {
      throw new Error('a retry pays at least one person, and this one names nobody');
    }
    const seen = new Set<number>();
    for (const i of indices) {
      if (!Number.isInteger(i) || i < 0 || i >= recorded.leaves.length) {
        throw new Error(
          `the ${leg} leg of run ${run.id} pays ${recorded.leaves.length} people; there is no `
          + `person ${i} on it to retry`);
      }
      if (seen.has(i)) throw new Error(`person ${i} is named twice on this retry`);
      seen.add(i);
    }
    if (payable.leaves.length !== indices.length
        || payable.leaves.some((leaf, at) => leaf !== recorded.leaves[indices[at]!])) {
      throw new Error(
        'this retry\'s leaves are not the leaves the leg already holds for the people it names. '
        + 'The leaf is the payment - the same leaf is refused a second time and a different one is '
        + 'not - so a retry over different leaves would pay those people again.');
    }
    if (payable.run.payees !== BigInt(indices.length)) {
      throw new Error(
        `this retry names ${indices.length} people and its material binds ${payable.run.payees}. `
        + 'The count is part of what the signers approve.');
    }
    if (payable.rootOf(payable.leaves) !== payable.run.root) {
      throw new Error(
        'this retry\'s payout root is not the root over its own leaves, so what the signers '
        + 'would approve is not the proposal these people are in. Every payment against it would be '
        + 'refused, after the signatures were collected and the fee was spent.');
    }
    /*
     * **A RETRY IS A RAISE, AND IT IS NOT RAISED OVER PEOPLE ANOTHER RUN FOR THE
     * PERIOD HAS BEEN RAISED TO PAY.** Their leaves in that other run are not
     * these, so the account could pay them from both.
     */
    this.refuseRaisingOverAnotherRun(run, viewingKey);
    const people = legEmployees(run, leg);
    if (people.length !== recorded.leaves.length) {
      throw new Error(
        `the ${leg} leg of run ${run.id} lists ${people.length} people and was raised over `
        + `${recorded.leaves.length} leaves, so which person each leaf belongs to cannot be said.`);
    }

    const at = new Date().toISOString();
    const entries: ShieldedEntry[] = indices.map(i => {
      const e = people[i]!;
      return {
        id: 'ent_' + nanoid(10),
        kind: 'payroll',
        asset: e.asset,
        amount: e.amount,
        counterparty: e.name,
        memo: `${run.period} salary`,
        at,
        runId: run.id,
        recipientId: e.id,
      };
    });

    /*
     * **A RETRY WHOSE RAISE THREW IS RAISED AGAIN AS ITSELF.** Found by the
     * people it pays, among the rounds written down for this leg that no
     * attempt on the leg has been confirmed as.
     */
    const confirmed = new Set((recorded.retries ?? []).map(r => r.proposalId).filter(Boolean));
    const earlier = this.accounts.payrollRoundsOf(run.accountId, viewingKey).filter(r =>
      r.runId === run.id && r.asset === leg && r.retry !== undefined && isLiveRound(r)
      && !confirmed.has(r.id) && sameList(r.retry, indices));
    if (earlier.length > 1) {
      throw new Error(
        `this retry on the ${leg} leg of run ${run.id} is written down as ${earlier.length} rounds `
        + `that may be on chain (${earlier.map(r => r.id).join(', ')}). Cancel all but one of them `
        + '(cancelling asks the chain first) before raising it again.');
    }
    const again = earlier[0]?.id;
    if (again !== undefined) {
      this.accounts.refuseRaisingADifferentRound(run.accountId, again, viewingKey, payable.run, leg);
    }
    await this.refuseARetryOverPeopleCovered(run, leg, legRound, indices, payable.leaves, again, viewingKey);

    const beforeRaising = this.requireRun(runId, viewingKey);
    const leg0 = beforeRaising.payout?.[leg];
    if (!leg0) throw new Error(`the ${leg} leg of run ${run.id} has lost its payout material`);
    if (!(leg0.retries ?? []).some(r => r.proposalId === undefined && isThisRetry(r, payable))) {
      const retry: RunRetry = {
        originalIndices: [...indices],
        root: payable.run.root,
        payees: payable.run.payees,
        opensAt: payable.run.opensAt,
        closesAt: payable.run.closesAt,
        vault: payable.run.vault,
        proposedBy,
        at,
      };
      leg0.retries = [...(leg0.retries ?? []), retry];
      this.putRun(beforeRaising, viewingKey);
    }

    const proposal = await this.accounts.proposeRun({
      accountId: run.accountId,
      viewingKey,
      /* Headcount and period, never amounts and never the asset - as a leg's own. */
      summary: `Payroll ${run.period}, retry for ${indices.length} recipients`,
      payload: { runId: run.id, entries, retry: [...indices] },
      asset: leg,
      run: payable.run,
      /* The leg's own payments for the people this retries, in the retry's tree order. */
      payments: indices.map(i => recorded.facts[i]!),
      proposedBy,
      ...(again !== undefined ? { again } : {}),
      ...(how?.onDevice ? { onDevice: true as const } : {}),
    });

    const afterRaising = this.requireRun(runId, viewingKey);
    const pending = afterRaising.payout?.[leg]?.retries
      ?.find(r => r.proposalId === undefined && isThisRetry(r, payable));
    if (pending) {
      pending.proposalId = proposal.id;
      this.putRun(afterRaising, viewingKey);
    }
    return proposal;
  }

  /**
   * **A RETRY MAY NAME ONLY PEOPLE NOBODY HAS PAID AND NO OTHER ROUND CAN STILL
   * PAY.** Called under the leg's hold, before anything about the retry is
   * written down, so a refusal writes nothing. Each clause refuses the whole
   * retry and names the people it is about, so the person choosing can choose
   * again; none of them drops somebody and raises the rest.
   *
   * A round stops counting once its window has closed, whatever else is true
   * of it: nothing can be paid against a round outside its window, and a round
   * whose window has opened can no longer be withdrawn, so counting it for
   * longer would leave its people unretryable for ever. Windows are compared
   * with this machine's clock, which is approximate: a clock that runs fast
   * lets a retry through while another round could still pay the same people
   * on chain. The account records a payment by its leaf and the retry reuses
   * each person's leaf, so what that costs is a second fee and a round that
   * cannot complete, never a second payment.
   *
   * 1. **THE LEG'S OWN ROUND, WHILE ITS WINDOW IS OPEN**, unless it was
   *    withdrawn or stopped by policy. It can still pay every one of them.
   * 2. **ANOTHER RETRY ON THIS LEG THAT NAMES ANY OF THE SAME PEOPLE**, neither
   *    withdrawn nor stopped by policy, while its window is open - sent, sent
   *    from a device and not yet seen on chain, or only written down.
   * 3. **A RETRY ROUND WRITTEN DOWN FOR THIS LEG THAT THE RUN WAS NEVER TOLD
   *    ABOUT** - its raise threw after the proposal was written - naming any of the
   *    same people, other than the one this raise is sending again as itself.
   *    Its window is read off the retries written onto the leg for the same
   *    people; with none to read, it counts until it is withdrawn.
   * 4. **ANYBODY THE ACCOUNT RECORDS AS PAID**, asked of the ledger by leaf. A
   *    ledger that cannot say refuses the retry: *cannot say* is not *nobody*.
   *    The answer is used only to refuse. What stops a second payment is the
   *    account, which refuses a leaf it has already paid.
   *
   * And before all four, **ANYBODY THE RUN MARKED NOT TO BE PAID**: a person
   * the run's own record of who it left out names, by the decision in force
   * for them. Matched by the person, because that record is kept over the
   * people left out rather than over the leg's leaves. A record that is not
   * this run's refuses the retry rather than being read as nobody.
   */
  private async refuseARetryOverPeopleCovered(
    run: PayrollRun, leg: AssetId, legRound: Proposal, indices: readonly number[], leaves: readonly Hex[],
    again: string | undefined, viewingKey: Hex,
  ): Promise<void> {
    const recorded = run.payout![leg]!;
    const nowInSeconds = BigInt(Math.floor(Date.now() / 1000));
    const people = (xs: readonly number[]) => `#${[...xs].sort((a, b) => a - b).map((i) => i + 1).join(', #')}`;
    const isAre = (xs: readonly number[]) => (xs.length === 1 ? 'is' : 'are');
    const when = (s: bigint) => `${new Date(Number(s) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const named = new Set(indices);
    const stopped = (p: Proposal) => p.status === 'cancelled' || p.status === 'blocked';

    if (run.skips) {
      const register = registerFor(run.skips.decisions, run.id, run.skips.people.length);
      const notToPay = new Set(skippedIndices(register).map((i) => run.skips!.people[i]!.employeeId));
      const onTheLeg = legEmployees(run, leg);
      const marked = indices.filter((i) => notToPay.has(onTheLeg[i]!.id));
      if (marked.length > 0) {
        throw new Error(
          `${people(marked)} ${isAre(marked)} marked on run ${run.id} as not to be paid, by a decision on record. A retry `
          + 'pays only people the run meant to pay, so none was raised. Nothing was written down.');
      }
    }

    if (!stopped(legRound) && nowInSeconds < recorded.closesAt) {
      throw new Error(
        `the ${leg} leg of run ${run.id} can still pay everybody on it until ${when(recorded.closesAt)}, when its `
        + 'window closes. A retry now would be a second round over the same people. Retry whoever it has not paid '
        + 'once its window has closed. Nothing was written down.');
    }

    for (const r of recorded.retries ?? []) {
      if (r.proposalId === undefined || nowInSeconds >= r.closesAt) continue;
      const round = this.accounts.requireProposal(r.proposalId, viewingKey);
      if (stopped(round)) continue;
      const shared = r.originalIndices.filter((i) => named.has(i));
      if (shared.length === 0) continue;
      const until = when(r.closesAt);
      throw new Error(
        `${people(shared)} ${isAre(shared)} already on retry ${r.proposalId} of the ${leg} leg of run ${run.id}, `
        + (round.raisedAt
          ? `which can still pay them until ${until}. Retry them once its window has closed.`
          : round.txRef
            ? `which was sent from a device and is not yet seen on chain. Send it again by retrying exactly `
              + `${people(r.originalIndices)} with its window and vault, or retry them once its window closes at ${until}.`
            : `which is written down and has not been sent. Send it by retrying exactly ${people(r.originalIndices)} `
              + `with its window and vault, or retry them once its window closes at ${until}.`)
        + ' Nothing was written down.');
    }

    /* Clause 3, as `untoldRetryRounds` decides it, which is what the page reads too. */
    const legRounds = this.accounts.payrollRoundsOf(run.accountId, viewingKey)
      .filter((r) => r.runId === run.id && r.asset === leg);
    for (const { round: r, people: onIt, closesAt } of untoldRetryRounds(recorded.retries ?? [], legRounds, nowInSeconds, again)) {
      const shared = onIt.filter((i) => named.has(i));
      if (shared.length === 0) continue;
      throw new Error(
        `${people(shared)} ${isAre(shared)} on retry ${r.id} of the ${leg} leg of run ${run.id}, whose raise did not `
        + 'answer and which may be on chain. Retry exactly '
        + `${people(onIt)} again with its window and vault to send it as itself`
        + (closesAt !== undefined ? `, or retry them once its window closes at ${when(closesAt)}.` : '.')
        + ' Nothing was written down.');
    }

    const among = await this.accounts.paidAmong(run.accountId, [...leaves]);
    if (among === null || !among.known) {
      throw new Error(
        'who has been paid on this run cannot be told: the ledger this service is wired to '
        + `${among === null ? 'does not show this account' : 'does not record payments'}. A retry names only people `
        + 'nobody has paid, so none is raised until that can be said. Try again once the ledger answers. '
        + 'Nothing was written down.');
    }
    const paid = new Set(among.paid.map((h) => h.toLowerCase()));
    const already = indices.filter((_, at) => paid.has(leaves[at]!.toLowerCase()));
    if (already.length > 0) {
      throw new Error(
        `${people(already)} ${already.length === 1 ? 'has' : 'have'} already been paid, as the account records. A retry `
        + 'names only people nobody has paid. Reload the run and retry whoever it still shows unpaid. '
        + 'Nothing was written down.');
    }
  }

  /**
   * **EVERY RUN FOR THIS PERIOD THAT PAYS THE SAME PEOPLE THE SAME AMOUNTS,
   * AND HOW FAR EACH ONE GOT.**
   *
   * The same people means the same names in the same currencies for the same
   * amounts, in any order. Every run is counted, drafts and withdrawn ones
   * included, because a draft can be raised at any moment and a withdrawn
   * round's run can be raised again; what differs is the sentence a person
   * reads about it.
   */
  private runsRepeating(
    accountId: string, period: string, content: string, viewingKey: Hex, excluding?: string,
  ): RepeatedRun[] {
    const rounds = this.accounts.payrollRoundsOf(accountId, viewingKey);
    return this.store.listRuns(accountId)
      .filter(r => samePeriod(r.period, period) && r.id !== excluding)
      .map(r => this.openRun(r, viewingKey))
      .filter(r => contentOf(r.employees) === content)
      .map(r => {
        const mine = rounds.filter(x => x.runId === r.id);
        const live = mine.filter(isLiveRound);
        const state: RepeatedRun['state'] = live.some(x => x.raisedAt) ? 'on chain'
          : live.length ? 'raised, not confirmed by the chain'
          : mine.some(x => x.status === 'cancelled') ? 'withdrawn'
          : 'drawn up, not raised';
        return { run: r, state };
      });
  }

  /**
   * **ANOTHER RUN FOR THIS PERIOD, ALREADY RAISED, THAT PAYS ANY OF THE SAME
   * PEOPLE OR PAYS THE SAME PAYROLL.**
   *
   * The same people are the same roster entries; the same payroll is the same
   * names, currencies and amounts, which is how an ad hoc run is recognised,
   * since its people have no roster entries to compare. Only a run with a round
   * that may be on chain counts: a draft pays nobody until it is raised, and
   * whatever is raised second - a run's own leg, or a retry on a run - is what
   * this refuses. A confirmation on either run naming the other lets the pair
   * through.
   *
   * **FOR THIS PERIOD MEANS FOR THIS MONTH, NOT FOR THIS STRING.** This is the
   * last refusal standing between a restart and a second set of payments, and
   * it selected the runs it compares against by string equality on the period.
   * A person whose raise failed restarts it by hand and retypes the month, and
   * a month retyped with a trailing space or without its leading zero was a
   * different period here: the people test below was never reached, and both
   * runs settled. The comparison is on the month the two runs name.
   *
   * **AND THE MONTH IS WHAT SEPARATES THEM, WHICH IS WHY IT IS STILL ASKED.**
   * The people test cannot stand on its own. A payroll pays the same roster the
   * same amounts every month, so a run for next month and a second run for this
   * one are the same people and the same content, and the month they are for is
   * the only thing that tells them apart. A round of this account stays live
   * from the moment it is raised, so comparing the people alone would refuse
   * next month's payroll for everybody paid in this one.
   */
  private refuseRaisingOverAnotherRun(run: PayrollRun, viewingKey: Hex): void {
    const live = new Set(this.accounts.payrollRoundsOf(run.accountId, viewingKey)
      .filter(isLiveRound).map(r => r.runId));
    const mine = new Set(run.employees.map(e => e.id));
    const content = contentOf(run.employees);
    const clashes = this.store.listRuns(run.accountId)
      .filter(r => samePeriod(r.period, run.period) && r.id !== run.id && live.has(r.id))
      .map(r => this.openRun(r, viewingKey))
      .filter(r => !(run.repeats?.of ?? []).includes(r.id) && !(r.repeats?.of ?? []).includes(run.id))
      .filter(r => contentOf(r.employees) === content || r.employees.some(e => mine.has(e.id)));
    if (clashes.length === 0) return;
    const ids = clashes.map(r => r.id).join(', ');
    throw new Error(
      `${clashes.length === 1 ? `run ${ids} has` : `runs ${ids} have`} already been raised for `
      + `${run.period} to pay some of the same people. The two runs give each of them different `
      + 'payment secrets, so nothing on chain would connect them, both could be approved and '
      + 'paid, and they would be paid twice. Pay them from the run already raised: raise it again '
      + 'if its raise failed, or raise a retry on it for anybody it has not reached. A run that '
      + 'means to pay them a second time has to carry a confirmation naming that run, and no door '
      + 'in this product yet takes one for a run drawn from the roster.');
  }

  /**
   * **A DRAFT RUN FOR THIS PERIOD THAT A RAISE HAS ALREADY BEEN ATTEMPTED FOR.**
   * Refused at the roster door, which draws up one run per period, because
   * drawing it up again gives everybody on it new payment secrets.
   */
  private refuseAPayrollThatMayBeOnChain(accountId: string, period: string, viewingKey: Hex): void {
    const live = this.accounts.payrollRoundsOf(accountId, viewingKey).filter(isLiveRound);
    const raised = this.store.listRuns(accountId)
      .filter(r => samePeriod(r.period, period) && live.some(x => x.runId === r.id));
    if (raised.length === 0) return;
    const seen = raised.some(r => live.some(x => x.runId === r.id && x.raisedAt));
    throw new Error(
      `a run for ${period} already exists and a round has been raised for it: `
      + `${raised.map(r => r.id).join(', ')}. `
      + (seen
        ? 'The chain has been seen to hold that round. '
        : 'The chain has not been seen to hold it, which is not the same as it not being there: a '
          + 'raise can fail after the network already has it. ')
      + 'Drawing this payroll up again as a new run would give everybody on it new payment '
      + 'secrets, and both rounds could then be approved and paid, so everybody would be paid '
      + 'twice. Raise that run again unchanged - it is asked of the chain first and cannot open a '
      + 'second round - and if some people on it are not paid by the time its window closes, '
      + 'raise a retry on it for them.');
  }

  /**
   * **A LEG IS PROPOSED WHILE THE PROPOSAL IT POINTS AT STANDS, AND NOT BECAUSE
   * IT ONCE POINTED AT ONE.** The run keeps which proposal each leg was raised
   * as, and nothing clears that pointer; a leg whose proposal was withdrawn is
   * therefore free to be raised again, as a new proposal, and the pointer moves
   * to it. Every other state of the proposal it names - written down and not
   * yet sent, open, approved, or stopped by this company's policy - still
   * refuses.
   *
   * **AND A WITHDRAWN LEG IS NOT RAISED AGAIN WHILE A RETRY ON IT MAY STILL
   * PAY.** A retry pays some of the leg's people from a smaller tree. Raising
   * the leg again pays all of them, so while any retry on the leg is neither
   * withdrawn nor stopped, the two could both pay somebody; that retry is
   * withdrawn first.
   */
  private refuseALegThatIsProposed(run: PayrollRun, leg: AssetId, viewingKey: Hex): void {
    const pointed = run.proposalIds[leg];
    if (!pointed) return;
    const standing = this.accounts.requireProposal(pointed, viewingKey).status;
    if (standing !== 'cancelled') {
      throw new Error(
        `the ${leg} leg of this run is already proposed, as ${pointed}, which is ${standing}. A leg is raised `
        + 'again only once that proposal is withdrawn - withdrawing asks the chain - and then as a new proposal.');
    }
    const retries = this.accounts.payrollRoundsOf(run.accountId, viewingKey).filter(r =>
      r.runId === run.id && r.asset === leg && r.retry !== undefined && isLiveRound(r));
    if (retries.length > 0) {
      throw new Error(
        `the ${leg} leg of run ${run.id} was withdrawn, and a retry on it is still live `
        + `(${retries.map(r => r.id).join(', ')}). Raising the leg again would raise all of its people while `
        + 'that retry can still pay some of them. Withdraw the retry first - withdrawing asks the chain - '
        + 'and raise the leg again after.');
    }
  }

  /** A round seen on chain that is neither withdrawn nor stopped by policy. */
  private roundMayPay(proposalId: string, viewingKey: Hex): boolean {
    const p = this.accounts.requireProposal(proposalId, viewingKey);
    return Boolean(p.raisedAt) && p.status !== 'cancelled' && p.status !== 'blocked';
  }

  /**
   * **THE PROPOSAL THIS LEG HAS ALREADY BEEN RAISED AS, IF ANY, THAT MAY BE ON
   * CHAIN AND THAT THE RUN WAS NEVER TOLD ABOUT.** More than one is refused
   * rather than chosen between.
   */
  private earlierRoundOfLeg(run: PayrollRun, leg: AssetId, viewingKey: Hex): string | undefined {
    const rounds = this.accounts.payrollRoundsOf(run.accountId, viewingKey).filter(r =>
      r.runId === run.id && r.asset === leg && r.retry === undefined && isLiveRound(r));
    if (rounds.length > 1) {
      throw new Error(
        `the ${leg} leg of run ${run.id} is written down as ${rounds.length} rounds that may be on `
        + `chain (${rounds.map(r => r.id).join(', ')}), and a leg is raised as one. Cancel all but `
        + 'one of them (cancelling asks the chain first) before raising this leg again.');
    }
    return rounds[0]?.id;
  }

  /*
   * **`settle` STOOD HERE AND IS DELETED.**
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

  /**
   * **EVERY PAYSLIP SEALED TO ONE PUBLIC KEY, AS CIPHERTEXT.**
   *
   * The caller has already shown it holds the secret for this key; that is the
   * route's job and not this one's. What comes back cannot be read without that
   * secret: each slip is sealed under its own key and that key is wrapped to
   * this public key, so the service handing it over reads nothing. The run's
   * own facts travel beside it - its period, whether it has settled, and which
   * ledger wrote it - because those are what a payee needs to know a payment
   * happened, and they are about the payee's own run.
   *
   * No viewing key is taken and none is needed. The key is matched against the
   * public half each roster record carries outside its seal, which is the half
   * every payslip for that person was wrapped to.
   */
  payslipsFor(wrappingPublicKey: Hex): SealedPayslip[] {
    const key = wrappingPublicKey.toLowerCase();
    const out: SealedPayslip[] = [];
    for (const account of this.store.listAccounts()) {
      /* For a slip sealed before it named its key: the roster record's key now. */
      const mine = new Set(this.store.listEmployees(account.id)
        .filter(e => (e.wrappingPublicKey ?? '').toLowerCase() === key)
        .map(e => e.id));
      for (const run of this.store.listRuns(account.id)) {
        for (const p of run.payslips) {
          const toThisKey = p.sealedTo !== undefined
            ? p.sealedTo.toLowerCase() === key
            : mine.has(p.employeeId);
          if (!toThisKey) continue;
          out.push({
            runId: run.id, period: run.period, status: run.status,
            settledAt: run.settledAt ?? null, wiring: run.wiring ?? null,
            issuedBy: p.issuedBy ?? null,
            wrapped: p.wrapped, slip: p.slip,
          });
        }
      }
    }
    return out.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));
  }

  /**
   * **EVERY ADDRESS A COMPANY'S PAYSLIPS WERE SEALED UNDER, FROM ANY ONE OF
   * THEM.** A payee who knows their company only by the address it has today
   * would otherwise ask their wallet for that address alone, and every slip
   * sealed before the company moved would stay closed to them. So the answer is
   * the company's address now and every address a slip of theirs names.
   *
   * These are contract addresses, which a chain publishes; nothing here says
   * who was paid, how much, or how many.
   */
  payslipAddressesOf(companyAddress: string): string[] {
    const asked = companyAddress.toLowerCase();
    const found = new Set<string>();
    for (const account of this.store.listAccounts()) {
      const now = companyAddressForOffer(this.store, account.id);
      const named = this.payslipAddressesNamedBy(account.id);
      if (now !== asked && !named.has(asked)) continue;
      if (now) found.add(now);
      for (const a of named) found.add(a);
    }
    return [...found].sort();
  }

  /** Every company address one company's payslips name, lower-cased. */
  private payslipAddressesNamedBy(accountId: string): Set<string> {
    const named = new Set<string>();
    for (const run of this.store.listRuns(accountId)) {
      for (const p of run.payslips) if (p.issuedBy) named.add(p.issuedBy.toLowerCase());
    }
    return named;
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
      /*
       * **THE STRONGEST BELIEF THIS PRODUCT CREATES IN ANYBODY IS FORMED HERE,
       * AND IT IS FORMED FROM ONE RECORD.**
       *
       * The rule that protects a company works by refusing to show a run that
       * never reached a chain beside one that did. **A payslip is a list of
       * one, so that rule can never fire on it** - and the person reading it
       * has no second record to compare against, no other channel, and no
       * reason to doubt a date. So the word travels with the payslip rather
       * than being withheld as company detail: *settled* and *settled on a
       * chain* are different sentences to the person being paid.
       */
      wiring: run.wiring ?? null,
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
     * **THIS GATE CANNOT PASS, AND THE SENTENCE NOW SAYS SO.**
     *
     * *"cannot attest an unsettled run"* stood here, and it describes a run —
     * as though settling one were a thing a person could go and do. **Measured:
     * `run.status` is assigned in exactly two places in `src/`, `'draft'`
     * (`:2012`) and `'proposed'`, and `'settled'` is assigned NOWHERE; nor is
     * `run.settledAt`, which is only read.** The writer that set both, `settle`,
     * went with the balance, and the note twenty lines above
     * says so in its own words: *"NOTHING IN THIS SYSTEM PAYS ANYBODY NOW."*
     *
     * **SO `this.proofs.prove` BELOW IS UNREACHABLE, AND SO IS
     * `store.putAttestation`, WHICH MAKES `verifyAttestation` UNREACHABLE
     * TOO** — the store can never hold a row. `SimulatedProofSystem` is wired
     * live and both of its methods are dead in the shipped product.
     *
     * **NOT REMOVED, AND THE REASON IS NOT RELUCTANCE:** the statement is real
     * and is what a vault-settled run will prove. What is corrected is the
     * claim — a refusal names the door that resolves it, and when there is no
     * door the honest refusal says that instead of naming a step nobody can
     * take.
     */
    if (run.status !== 'settled') {
      throw new Error(
        `run ${run.id} is ${run.status}, and no run in this product can be anything else: ` +
          'a payroll total is proved from a run a VAULT has paid, and the vault payment path ' +
          'is not built (the only path that ever settled a run was removed). Nothing assigns ' +
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
   * **THERE IS NO BALANCE TO ATTEST TO.**
   *
   * This read `state.balances[asset]` and proved it was at least `threshold`.
   * The account keeps no balance, so the only honest answer this could give is
   * "at least zero", and issuing an attestation saying an account HOLDS an
   * amount when it holds nothing is exactly the failure to avoid — a signed
   * claim about money, from a system with no money in it.
   *
   * **REMOVING THE FEATURE IS NOT THIS METHOD'S TO DO.** `attestSolvency` and
   * its screen are reserved for work of their own, and reserving them is not
   * the same as leaving them issuing a true-by-vacuity attestation — which is
   * what this would do if it were left reading a field that is gone. So the
   * method refuses and the screen is untouched, for that work to take whole.
   * When solvency comes back it is the VAULT's holding that is proved, which is
   * a different statement over a different commitment.
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
        'at all. It is an authority over a vault, not a holder of money, so there is ' +
        'nothing here to prove a threshold against. Proving what a VAULT holds is a different ' +
        'statement and is not built.',
    );
  }

  /**
   * **IT CAN ONLY EVER ANSWER `false`, AND THAT IS THE DIRECTION THAT CALLS A
   * TRUE CLAIM FALSE.**
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
          'requires a run a vault has paid, and the vault payment path is not built. ' +
          'This is not a proof that failed to verify — no proof was ever issued.',
      );
    }
    if (new Date(att.expiresAt) < new Date()) return false;
    return this.proofs.verify(att.circuit as any, att.publicInputs, att.proof);
  }

  /* ---------------- sealing runs ---------------- */

  private putRun(run: PayrollRun, viewingKey: Hex): void {
    const { employees, totals, proposalIds, payout, skips, repeats, ...operational } = run;
    /*
     * **A RUN'S MARKER IS ITS OWN AND IT IS NOT ITS COMPANY'S.**
     *
     * A company outlives a change of ledger; a run does not, because a run
     * that was never raised against a chain cannot be re-raised against one
     * without becoming a different run. So the run records what wrote IT, and
     * reading a company's marker in its place would vouch for payslips on the
     * strength of when the company was opened.
     *
     * Written on the write that creates the record and by nothing afterwards,
     * for the reason a round's is: this method runs again when a run is raised
     * and again when it settles, and the running ledger at those moments is
     * not evidence about the moment the run was drawn up. **A run already on
     * disk that says nothing keeps saying nothing** - stamping it on the next
     * write would put a guess where the one irrecoverable fact should be.
     */
    const already = this.store.getRun(run.id);
    this.store.putRun({
      ...operational,
      wiring: already ? already.wiring ?? null : this.accounts.wiring,
      // Outside the envelope so a run can be found by its proposals; the map
      // that says which asset each leg is in stays inside, so the store cannot
      // see that this company pays anyone in ether.
      proposalIds: [...Object.values(proposalIds), ...retryProposalIdsOf(payout)].sort(),
      keyEpoch: this.accounts.keyEpochOf(run.accountId),
      sealed: sealRecord(
        'payroll', run.accountId,
        { employees, totals, proposalIds, payout, skips, repeats } satisfies RunSecrets, viewingKey,
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

  /**
   * **EVERYTHING ONE LEG'S PAYOUT MATERIAL IS BUILT FROM, GATHERED IN ONE
   * PLACE.**
   *
   * The material itself is built above this layer, because hashing a merkle tree
   * the way the chain hashes it means reaching a runtime this layer may not
   * reach. What this layer holds is the INPUTS — who is being paid on this leg,
   * in what order, and the account's payout seeds — and gathering them here is
   * what stops each caller assembling its own set.
   *
   * **THE LEG IS RESOLVED HERE AND TRAVELS WITH THE ANSWER.** The identifier
   * returned is the leg's, not the run's, and it is what the payees'
   * secrets will be derived from; a caller that composed its own would be
   * writing the rule that decides whether two legs of one payroll share their
   * secrets.
   *
   * **THE SEEDS ARE THE SECRET BEHIND EVERY NONCE ON THE RUN.** They are
   * returned so that one call can build a run and no more; nothing may put one
   * in a response, a log or an error.
   */
  async runMaterialInputs(
    runId: string, viewingKey: Hex, asset?: AssetId,
  ): Promise<{
    accountId: string;
    /** The identifier this leg's payee secrets are derived from. */
    runId: string;
    facts: ShieldedPaymentFacts[];
    seeds: PayoutSeed[];
    /**
     * The seed generation the material must be built under, when it is not the
     * current one: set only for a leg already raised once whose round may be on
     * chain, so raising it again builds the same leaves. Absent means current.
     */
    epoch?: number;
  }> {
    const run = this.requireRun(runId, viewingKey);
    const leg = legOf(run, asset);
    /*
     * **A LEG ALREADY RAISED ONCE IS RAISED AGAIN FROM WHAT IT WAS RAISED OVER.**
     * Its round may be on chain. The roster may have moved since - a salary
     * corrected, a person marked a leaver, a signer removed and the seed moved
     * on - and material built from the roster now would be a different round
     * over different leaves, which is refused; so the only way to raise the same
     * round again would be closed by the very change that makes it necessary.
     */
    const recorded = run.payout?.[leg];
    const earlier = recorded && !run.proposalIds[leg]
      ? this.earlierRoundOfLeg(run, leg, viewingKey) : undefined;
    /*
     * **ONLY WHEN THAT ROUND IS ON CHAIN, OR THE CHAIN CANNOT SAY.** A round the
     * chain does not hold would be raised for the first time from the record,
     * past whatever the roster has refused since - a person marked a leaver, say.
     * So that case is built from the roster like any leg, and if the roster has
     * moved the raise is refused as a different round and says to withdraw it.
     */
    if (recorded && earlier !== undefined
        && await this.accounts.whereIsRound(earlier, viewingKey) !== 'absent') {
      const people = legEmployees(run, leg);
      return {
        accountId: run.accountId,
        runId: recorded.runId,
        facts: recorded.facts.map((f, i) => ({
          ...f, payee: payrollPayee(people[i]?.name ?? 'a person on this run', f.payee),
        })),
        seeds: await this.accounts.payoutSeedsOf(run.accountId, viewingKey),
        epoch: recorded.epoch,
      };
    }
    return {
      accountId: run.accountId,
      runId: runIdForLeg(run, leg),
      facts: this.paymentFactsFor(run.id, viewingKey, leg),
      seeds: await this.accounts.payoutSeedsOf(run.accountId, viewingKey),
    };
  }

  /**
   * **WHAT RAISING ONE LEG WILL ASK ITS VAULT TO PAY, FOR A SIGNER'S DEVICE TO
   * CHECK AGAINST THE VAULT'S NOTES BEFORE IT ASKS FOR THE RAISE.**
   *
   * The same payments the raise is checked against, from the same inputs its
   * material is built from, so the device asks about the proposal that will
   * actually be raised. Each payment is its payee's kind, its token and its
   * amount, and nothing else: no address, and none of the seeds the inputs are
   * gathered with. A private payment can only be checked where the vault's pool
   * is opened, which is the device, and this is what the device needs to ask.
   */
  async legPaymentsAsked(runId: string, viewingKey: Hex, asset?: AssetId): Promise<{
    asset: AssetId;
    payments: Array<PaymentChecked<'shielded' | 'unshielded', bigint>>;
  }> {
    const run = this.requireRun(runId, viewingKey);
    const leg = legOf(run, asset);
    /*
     * **A LEG WITH A PROPOSAL WRITTEN DOWN ASKS FOR WHAT WAS WRITTEN DOWN.** A
     * proposal is sent as it was written, so the device checks the payments that
     * will be sent, not the roster as it stands now; a roster edited since would
     * otherwise have the device check one set and the service send another.
     */
    const facts = this.writtenDownFactsOf(run, leg, viewingKey)
      ?? (await this.runMaterialInputs(runId, viewingKey, leg)).facts;
    return {
      asset: leg,
      payments: facts.map(paymentChecked),
    };
  }

  /**
   * **THE REFUSAL A RAISE GIVES FOR A LEG ALREADY PROPOSED, ASKED ON ITS OWN.**
   * A caller that compares anything about the raise first asks this before, so
   * a leg that cannot be raised at all is told so, rather than told something
   * about the raise that raising again would not change.
   */
  refuseRaisingAProposedLeg(runId: string, viewingKey: Hex, asset?: AssetId): void {
    const run = this.requireRun(runId, viewingKey);
    this.refuseALegThatIsProposed(run, legOf(run, asset), viewingKey);
  }

  /** The payments of the proposal this leg is written down as, unless it has none or it was withdrawn. */
  private writtenDownFactsOf(run: PayrollRun, leg: AssetId, viewingKey: Hex): PaymentFacts[] | undefined {
    const pointed = run.proposalIds[leg];
    const payout = run.payout?.[leg];
    if (!pointed || !payout) return undefined;
    if (this.accounts.requireProposal(pointed, viewingKey).status === 'cancelled') return undefined;
    return payout.facts;
  }

  /**
   * **WHAT ONE LEG OF A RUN WAS RAISED AGAINST, READ BACK OFF THE RECORD.**
   *
   * A payment view is built against a run's payout LEAVES and the window its
   * signers approved. Neither is on chain — the tree travels as a root — so both
   * live with the run here, written when the leg was raised.
   *
   * **`null` MEANS THIS LEG HAS NO MATERIAL, AND EVERY READER MUST HANDLE IT.**
   * A run raised before this product could build any carries none and never
   * will; a run in draft carries none yet. A reader that assembled an empty leaf
   * list for itself instead would get a view in which no payee is outstanding
   * and the run is therefore complete — *"all 0 paid"* over a payroll nobody has
   * been paid from. The absence is stated once, here, in a shape a reader is
   * forced to handle.
   *
   * **PER LEG, AND IT REFUSES TO GUESS WHICH.** A run that settles in two assets
   * has two approvals over two trees, and answering about one of them without
   * being asked is how a screen comes to report a payroll complete while
   * everybody in the other currency is still owed.
   */
  /**
   * **EVERYTHING NEEDED TO REBUILD ONE APPROVED LEG AND PAY IT, MONTHS LATER,
   * ON ANOTHER MACHINE.**
   *
   * The leaves a run was approved against are stored, but a leaf is not enough
   * to pay somebody: paying needs their merkle path, their blinding and their
   * nonce, and needs the vault told who to pay, in what, and how much. None of
   * the secrets is written down anywhere — they are DERIVED, from the account's
   * payout seed and the identity the run was raised under, which is what makes a
   * run belong to the account rather than to the laptop that raised it.
   *
   * **THE THREE THINGS THIS RETURNS ARE THE THREE THAT MUST NOT DRIFT.**
   *
   *   the identity   including which GENERATION of the payout seed. Seeds are
   *                  appended when a signer is removed, so *the current one* is
   *                  not the one an approved run was built from — ask for the
   *                  wrong generation and every payment is refused, with nothing
   *                  saying why
   *   the facts      **off the run's own record and never off the roster.** A
   *                  roster is live: somebody is marked a leaver, a salary is
   *                  corrected, an address is re-registered. Reading it again
   *                  would derive different leaves for a root that is already
   *                  signed, and marking one person a leaver would block the
   *                  rebuild of the whole leg
   *   the seeds      every generation of them, so the identity can select
   *
   * `null` for a leg with no material, exactly as the leaves are.
   */
  async payoutRebuildOf(
    runId: string, viewingKey: Hex, asset?: AssetId,
  ): Promise<{
    identity: { accountId: string; runId: string; epoch: number };
    facts: PaymentFacts[];
    seeds: PayoutSeed[];
  } | null> {
    const run = this.requireRun(runId, viewingKey);
    const leg = raisedLegOf(run, asset);
    const payout = leg ? run.payout?.[leg] : undefined;
    if (!payout) return null;
    return {
      identity: { accountId: run.accountId, runId: payout.runId, epoch: payout.epoch },
      facts: payout.facts,
      seeds: await this.accounts.payoutSeedsOf(run.accountId, viewingKey),
    };
  }

  /**
   * **WHAT A VAULT IS HANDED TO PAY ONE LEG, BESIDE EACH PAYEE'S OWN VALUES.**
   *
   * The vault recomputes the run's identity from the root, the count, the
   * window and the salt, folds in its own address, and asks the account whether
   * that round is approved. Every one of those is read off the leg's own record
   * and the run it was raised as - never off the roster and never off the
   * request - so a payment is built against exactly what the signers approved.
   *
   * `null` for a leg with no material, or one the chain was never asked to open:
   * a round with no raise has no identity a vault could present.
   */
  /**
   * **WHAT A SIGNER'S DEVICE BUILDS ONE LEG'S PROPOSAL FROM, WHILE THAT
   * PROPOSAL IS WRITTEN DOWN AND NOT YET SENT.** The run as the chain will be
   * asked to open it - read back off the leg's own record, never from the caller
   * - and the account's half of the call, read off the proposal's own sealed
   * payload.
   *
   * `null` when the leg has no proposal written down, or its proposal is already
   * confirmed on chain; the account refuses one that is not open or that a
   * device has already sent, with its own sentence.
   */
  async raiseOrderOf(runId: string, viewingKey: Hex, asset?: AssetId): Promise<{
    proposalId: string;
    chainId: Hex;
    run: { root: Hex; payees: bigint; opensAt: bigint; closesAt: bigint; vault: Hex };
    half: RaiseHalf;
    /** The digest of the payments written down, over what a device is handed to check them. */
    paymentsChecked: string;
  } | null> {
    const run = this.requireRun(runId, viewingKey);
    const leg = raisedLegOf(run, asset);
    const payout = leg ? run.payout?.[leg] : undefined;
    const proposalId = leg ? run.proposalIds[leg] : undefined;
    if (!leg || !payout || !proposalId) return null;
    const raised = this.accounts.requireProposal(proposalId, viewingKey);
    if (raised.raisedAt) return null;
    return {
      proposalId,
      chainId: raised.chainId,
      run: {
        root: payout.root, payees: payout.payees, opensAt: payout.opensAt, closesAt: payout.closesAt, vault: payout.vault,
      },
      half: await this.accounts.raiseHalfOf(proposalId, viewingKey),
      paymentsChecked: paymentsCheckedDigest(payout.facts.map(paymentChecked)),
    };
  }

  /**
   * **WHAT A RETRY OF SOME OF ONE LEG'S PEOPLE WILL ASK ITS VAULT TO PAY, FOR
   * A SIGNER'S DEVICE TO CHECK AGAINST THE VAULT'S NOTES BEFORE IT ASKS FOR THE
   * RETRY.** Read off the leg's own record and never off the roster, because a
   * retry pays each person the payment the leg was raised with: the same facts
   * the retry is raised against, in the order it names them. Each is a kind, a
   * token and an amount, and nothing else.
   *
   * It says nothing about whether a retry naming these people may be raised;
   * the retry itself asks that, every time.
   */
  retryPaymentsAsked(runId: string, viewingKey: Hex, indices: readonly number[], asset?: AssetId): {
    asset: AssetId;
    payments: Array<PaymentChecked<'shielded' | 'unshielded', bigint>>;
  } {
    const run = this.requireRun(runId, viewingKey);
    const leg = legOf(run, asset);
    const recorded = run.payout?.[leg];
    if (!recorded) {
      throw new Error(
        `the ${leg} leg of run ${run.id} has not been raised, so there is nobody on it to retry. `
        + 'Raise the leg first.');
    }
    return {
      asset: leg,
      payments: indices.map(i => {
        const f = Number.isInteger(i) ? recorded.facts[i] : undefined;
        if (!f) {
          throw new Error(
            `this run pays ${recorded.facts.length} people in ${leg}, so there is no person #${Number(i) + 1} on it to `
            + 'retry. Reload the run and choose again.');
        }
        return paymentChecked(f);
      }),
    };
  }

  /**
   * **A RETRY OF EXACTLY THESE PEOPLE THAT IS WRITTEN DOWN AND HAS NOT
   * REACHED THE CHAIN**, with the window and vault it was written down with.
   * A signer's device writes a retry down before it sends it, so a device that
   * stopped in between leaves one; retrying the same people again sends that
   * one as itself rather than raising a second round over the same leaves.
   * `null` when there is none. A retry whose window has closed is not one: it
   * can never pay anybody, so sending it would only spend a fee, and the people
   * on it may be retried with a window of their own.
   */
  unsentRetryOf(runId: string, viewingKey: Hex, indices: number[], asset?: AssetId): {
    proposalId: string; opensAt: bigint; closesAt: bigint; vault: Hex;
  } | null {
    const run = this.requireRun(runId, viewingKey);
    const leg = raisedLegOf(run, asset);
    const nowInSeconds = BigInt(Math.floor(Date.now() / 1000));
    for (const r of (leg ? run.payout?.[leg]?.retries : undefined) ?? []) {
      if (r.proposalId === undefined || !sameList(r.originalIndices, indices)) continue;
      if (nowInSeconds >= r.closesAt) continue;
      const written = this.accounts.requireProposal(r.proposalId, viewingKey);
      if (written.status === 'open' && !written.raisedAt) {
        return { proposalId: r.proposalId, opensAt: r.opensAt, closesAt: r.closesAt, vault: r.vault };
      }
    }
    return null;
  }

  /**
   * **WHAT A SIGNER'S DEVICE BUILDS A RETRY'S PROPOSAL FROM, WHILE IT IS
   * WRITTEN DOWN AND NOT YET SENT.** The retry is found by the proposal it was
   * written down as, among this leg's own retries, and its run is read back off
   * that record - never from the caller. `indices` are the people it pays, as
   * positions in the leg, so the device can check them against the vault again
   * before every send.
   *
   * `null` when this leg has no retry written down as that proposal, or the
   * chain already holds it.
   */
  async retryRaiseOrderOf(runId: string, viewingKey: Hex, proposalId: string, asset?: AssetId): Promise<{
    proposalId: string;
    chainId: Hex;
    run: { root: Hex; payees: bigint; opensAt: bigint; closesAt: bigint; vault: Hex };
    half: RaiseHalf;
    indices: number[];
    /** The digest of the retry's payments, over what a device is handed to check them. */
    paymentsChecked: string;
  } | null> {
    const run = this.requireRun(runId, viewingKey);
    const leg = raisedLegOf(run, asset);
    const payout = leg ? run.payout?.[leg] : undefined;
    const retry = payout?.retries?.find(r => r.proposalId === proposalId);
    if (!leg || !payout || !retry) return null;
    const raised = this.accounts.requireProposal(proposalId, viewingKey);
    if (raised.raisedAt) return null;
    return {
      proposalId,
      chainId: raised.chainId,
      run: { root: retry.root, payees: retry.payees, opensAt: retry.opensAt, closesAt: retry.closesAt, vault: retry.vault },
      half: await this.accounts.raiseHalfOf(proposalId, viewingKey),
      indices: [...retry.originalIndices],
      paymentsChecked: paymentsCheckedDigest(retry.originalIndices.map(i => paymentChecked(payout.facts[i]!))),
    };
  }

  privatePaymentOrderOf(runId: string, viewingKey: Hex, asset?: AssetId): {
    asset: AssetId; vault: Hex; proposal: Hex; salt: Hex;
    root: Hex; payees: bigint; opensAt: bigint; closesAt: bigint;
  } | null {
    const run = this.requireRun(runId, viewingKey);
    const leg = raisedLegOf(run, asset);
    const payout = leg ? run.payout?.[leg] : undefined;
    const proposalId = leg ? run.proposalIds[leg] : undefined;
    if (!leg || !payout || !proposalId) return null;
    const raised = this.accounts.requireProposal(proposalId, viewingKey);
    if (!raised.raisedAt) return null;
    return {
      asset: leg,
      vault: payout.vault,
      proposal: raised.chainId,
      salt: this.accounts.runSaltOf(proposalId, viewingKey),
      root: payout.root,
      payees: payout.payees,
      opensAt: payout.opensAt,
      closesAt: payout.closesAt,
    };
  }

  /**
   * **WHAT A VAULT IS HANDED TO PAY ONE APPROVED RETRY ON A LEG**, in the shape
   * `privatePaymentOrderOf` answers for the leg's own round, beside what the
   * retry's payments are checked against before anything is offered to pay.
   *
   * Everything is read off the retry as it was written onto the leg and the
   * proposal it was raised as - its root, count, window and vault, and that
   * round's salt and identity - never off the request. `indices` are the
   * people it pays, as positions in the leg, in the retry's own tree order, and
   * `leaves` are the leg's own leaves for them: the retry pays each person with
   * the leaf they already had, which is why the account can pay each of them
   * once whichever round reaches them first.
   *
   * `null` when this leg has no retry raised as that proposal, or the chain was
   * never seen to hold it: a round with no raise has no identity a vault could
   * present. Approval is not asked here; the vault asks the account.
   */
  retryPaymentOrderOf(
    runId: string, viewingKey: Hex, proposalId: string, asset: AssetId | undefined,
    /** The payout tree's own root function, passed in for the reason `payoutMaterialOf` gives. */
    rootOf: (leaves: Hex[]) => Hex,
  ): {
    order: {
      asset: AssetId; vault: Hex; proposal: Hex; salt: Hex;
      root: Hex; payees: bigint; opensAt: bigint; closesAt: bigint;
    };
    indices: number[];
    leaves: Hex[];
    window: { from: bigint; until: bigint };
    idFrom: (leaves: Hex[], w: { from: bigint; until: bigint }) => Hex;
  } | null {
    const run = this.requireRun(runId, viewingKey);
    const leg = raisedLegOf(run, asset);
    const payout = leg ? run.payout?.[leg] : undefined;
    const retry = payout?.retries?.find((r) => r.proposalId === proposalId);
    if (!leg || !payout || !retry) return null;
    const raised = this.accounts.requireProposal(proposalId, viewingKey);
    if (!raised.raisedAt) return null;
    return {
      order: {
        asset: leg,
        vault: retry.vault,
        proposal: raised.chainId,
        salt: this.accounts.runSaltOf(proposalId, viewingKey),
        root: retry.root,
        payees: retry.payees,
        opensAt: retry.opensAt,
        closesAt: retry.closesAt,
      },
      indices: [...retry.originalIndices],
      leaves: retry.originalIndices.map((i) => payout.leaves[i]!),
      window: { from: retry.opensAt, until: retry.closesAt },
      idFrom: (leaves, w) => this.accounts.runProposalIdFrom(proposalId, viewingKey, {
        root: rootOf(leaves), payees: BigInt(leaves.length), opensAt: w.from, closesAt: w.until,
      }),
    };
  }

  /**
   * **WHAT ONE LEG OF A RUN WAS RAISED AGAINST, READ BACK OFF THE RECORD.**
   *
   * A payment view is built against a run's payout LEAVES and the window its
   * signers approved. Neither is on chain — the tree travels as a root — so both
   * live with the run here, written when the leg was raised.
   *
   * **`null` MEANS THIS LEG HAS NO MATERIAL, AND EVERY READER MUST HANDLE IT.**
   * A run raised before this product could build any carries none and never
   * will; a run in draft carries none yet. A reader that assembled an empty leaf
   * list for itself instead would get a view in which no payee is outstanding
   * and the run is therefore complete — *"all 0 paid"* over a payroll nobody has
   * been paid from. The absence is stated once, here, in a shape a reader is
   * forced to handle.
   *
   * **PER LEG, AND IT REFUSES TO GUESS WHICH.** A run that settles in two assets
   * has two approvals over two trees, and answering about one of them without
   * being asked is how a screen comes to report a payroll complete while
   * everybody in the other currency is still owed.
   */
  payoutMaterialOf(
    runId: string, viewingKey: Hex,
    opts: {
      /** Which settlement leg. Required when the run settles in more than one. */
      asset?: AssetId;
      /**
       * **THE PAYOUT TREE'S OWN ROOT FUNCTION, PASSED IN AND NEVER
       * REIMPLEMENTED.**
       *
       * Supplying it is what turns the answer from a list of leaves into a list
       * of leaves PROVED to be this run's: the id the run is open under is
       * rebuilt from the leaves in hand, and a view whose leaves belong to some
       * other payroll is refused instead of rendered. It is optional because a
       * caller that cannot reach the runtime that hashes the tree can still have
       * an unverified view, clearly marked as one — and it is passed in rather
       * than imported because this layer must not reach that runtime at all.
       */
      rootOf?: (leaves: Hex[]) => Hex;
    } = {},
  ): RunInputs | null {
    /* Read for the refusal it carries: a run nobody may open is not a run whose
     * payments this caller may be told about. */
    const run = this.requireRun(runId, viewingKey);
    const leg = raisedLegOf(run, opts.asset);
    const payout = leg ? run.payout?.[leg] : undefined;
    if (!payout || !leg) return null;

    const window = { from: payout.opensAt, until: payout.closesAt };
    const proposalId = run.proposalIds[leg];

    /*
     * **THE PROOF IS OFFERED ONLY FOR A LEG THE LEDGER ACTUALLY RAISED.**
     *
     * A round can be recorded here and never reach a chain — a policy block
     * stops it before the call, and a failure after the call leaves the moment
     * unset. Rebuilding an id for one of those would compare two values this
     * process derived from one record and report the result as *proved against
     * the approved run*, which is a claim about a round the chain never held.
     *
     * **WHAT IT DOES BUY, SAID EXACTLY.** It proves that these leaves are the
     * ones this leg's approved root commits to — so a stale leaf list, a run
     * mixed up with another in the store, or a leg's material overwritten by
     * another leg's is refused rather than reported on. It does not prove that
     * the chain still holds the round; nothing here asks the chain anything.
     */
    let proposal: RunInputs['proposal'];
    if (opts.rootOf && proposalId) {
      const raised = this.accounts.requireProposal(proposalId, viewingKey);
      const rootOf = opts.rootOf;
      if (raised.raisedAt) {
        proposal = {
          id: raised.chainId,
          idFrom: (leaves, w) => this.accounts.runProposalIdFrom(proposalId, viewingKey, {
            root: rootOf(leaves),
            payees: BigInt(leaves.length),
            opensAt: w.from,
            closesAt: w.until,
          }),
        };
      }
    }

    /*
     * **THE LEG'S OTHER ATTEMPTS, SO A PERSON ONE OF THEM CAN STILL PAY IS NOT
     * REPORTED AS BEYOND REACH.** Only attempts seen on chain and neither
     * withdrawn nor stopped by policy: counting any other would hide the people
     * nothing can pay behind a round that cannot pay them.
     */
    const retries = (payout.retries ?? [])
      .filter(r => r.proposalId !== undefined && this.roundMayPay(r.proposalId, viewingKey))
      .map(r => ({ indices: [...r.originalIndices], window: { from: r.opensAt, until: r.closesAt } }));
    return { leaves: payout.leaves, window, proposal, ...(retries.length ? { retries } : {}) };
  }
}

/**
 * **WHAT AN ADMIN HAS TO SAY TO DRAW UP A RUN THAT REPEATS ANOTHER.**
 *
 * The shape the roster door uses for people left out of a run, applied to runs
 * repeated: refused by default, the refusal names what it found, and a person
 * proceeds only by naming that same set back, with a reason, under their own
 * name. The names are compared in both directions. A repeated run the admin did
 * not name is one they have not read about; a run they named that is not
 * repeated means the list they read has moved, and their agreement is about a
 * different payroll.
 *
 * **WHY A REPEAT IS REFUSED AT ALL.** Every run derives its own per-payee
 * payment secrets from its own id, so two runs over the same people are, to the
 * account, two unrelated sets of payments, and both can be paid. For a bonus or
 * a second invoice that is exactly right. For somebody whose first run failed
 * and who does not know whether it reached the chain, it is everybody paid
 * twice - and the way to try again is not a new run at all.
 */
export interface RepeatAcknowledgement {
  /** The same set as the runs this one repeats. Compared as a set. */
  runIds: string[];
  /**
   * Who is accepting it. Where there is a signed-in caller the served routes
   * take this from the signed-in caller and never from the request body.
   */
  by: string;
  /** Why, in their words. A blank reason is refused. */
  reason: string;
}

interface RepeatedRun {
  run: PayrollRun;
  state: 'on chain' | 'raised, not confirmed by the chain' | 'withdrawn' | 'drawn up, not raised';
}

/**
 * **A PAY PERIOD HAS ONE SPELLING, AND ANYTHING ELSE IS REFUSED HERE RATHER
 * THAN COMPARED LATER.**
 *
 * Every guard in this file against paying somebody twice asks whether two runs
 * are for the same period, and every one of them asked it by comparing the text
 * a person typed. So `2026-08 ` with a trailing space, or `2026-8` without the
 * zero, was a DIFFERENT period to all of them: a second payroll was drawn for
 * it beside the first, raised beside it, and everybody on both was paid twice,
 * each time under their own payment secrets so that nothing on chain connected
 * the two. Neither spelling is an attack. Both are a retype, and the restart a
 * person reaches for is exactly the moment they retype it.
 *
 * **SO A PERIOD STOPS BEING FREE TEXT AT THE POINT IT ENTERS.** A run is drawn
 * for a month, written `YYYY-MM`, and a month is what this returns: anything
 * that names August 2026 comes back as `2026-08` however it was typed, and a
 * string that names no month is refused, with the form that is wanted. The
 * guards then compare a value rather than a typing, and there is no longer such
 * a thing as a spelling they have not seen.
 *
 * **IT IS IN THE SERVICE AND NOT ONLY ON THE WAY IN.** The routes in front of
 * this are the doors the product happens to have today; a third one, a script,
 * or a call path added later would each reach those guards with whatever it was
 * handed. A refusal a caller cannot go around is the only kind that bounds
 * anything.
 */
export const canonicalPeriod = (period: string): string => {
  const written = period.trim();
  const named = /^(\d{4})-(\d{1,2})$/.exec(written);
  const month = named ? Number(named[2]) : 0;
  if (!named || month < 1 || month > 12) {
    throw new Error(
      `"${period}" does not name a pay period. A run is drawn for one month, written as the `
      + 'year, a hyphen and the month: 2026-08 is August 2026. Write the month that way and '
      + 'draw the run again.');
  }
  return `${named[1]}-${String(month).padStart(2, '0')}`;
};

/**
 * **TWO RUNS ARE FOR THE SAME PERIOD WHEN THEY NAME THE SAME MONTH**, whichever
 * way either of them spells it.
 *
 * **BOTH SIDES ARE READ, NOT ONLY THE NEW ONE.** A run already in the store was
 * written before a period had one spelling, and it is the run a new one has to
 * be compared against; reading only the incoming period would leave exactly the
 * pair this is here to catch. A period that names no month is compared as it
 * stands, so a record that cannot be read still matches itself and is never
 * quietly treated as a period of its own.
 */
const samePeriod = (a: string, b: string): boolean => {
  if (a === b) return true;
  let left: string;
  let right: string;
  try {
    left = canonicalPeriod(a);
    right = canonicalPeriod(b);
  } catch {
    return false;
  }
  return left === right;
};

/**
 * **WHAT A RUN PAYS, AS ONE COMPARABLE VALUE.** Names, currencies and amounts,
 * in any order: a run is a repeat of another by what it pays, not by how its
 * list happens to be sorted.
 */
const contentOf = (people: Array<{ name: string; asset: AssetId; amount: bigint }>): string =>
  JSON.stringify(people.map(p => [p.name, p.asset, String(p.amount)]).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1
      : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));

/** A round that is not withdrawn and was not stopped by this company's own policy may be on chain. */

const isThisRetry = (r: RunRetry, m: RetryMaterial): boolean =>
  sameList(r.originalIndices, m.originalIndices) && r.root === m.run.root
  && r.payees === m.run.payees && r.opensAt === m.run.opensAt && r.closesAt === m.run.closesAt
  && r.vault === m.run.vault;

/** Every proposal a leg's retries were raised as, so a run can be found by any of its rounds. */
const retryProposalIdsOf = (payout: Record<AssetId, RunPayout> | undefined): string[] =>
  Object.values(payout ?? {}).flatMap(p =>
    (p.retries ?? []).map(r => r.proposalId).filter((id): id is string => id !== undefined));

const repeatRefusal = (period: string, found: RepeatedRun[]): string =>
  `this run pays the same people the same amounts for ${period} as `
  + `${found.map(f => `run ${f.run.id} (${f.state})`).join(', ')}. Each run derives its own payment `
  + 'secrets, so to the account two runs are two unrelated sets of payments and nothing on chain '
  + 'stops both being paid: everybody on it would be paid twice. If an earlier run failed and it is '
  + 'not known whether it reached the chain, do not draw it up again. Raise that run again unchanged '
  + 'instead - it keeps its people\'s payment secrets, so nobody on it can be paid twice, and a '
  + 'round of it that may already be on chain is asked about rather than opened again - or raise a '
  + 'retry on it for the people it did not reach. '
  + `If this really is a second payment, confirm it by naming ${found.map(f => f.run.id).join(', ')} `
  + 'back with a reason.';

/**
 * **THE CONFIRMATION FOR A REPEATED RUN, CHECKED, OR THE REFUSAL.** Returns the
 * record to keep on the run, or nothing when the run repeats nothing.
 */
const acknowledgedRepeats = (
  period: string, found: RepeatedRun[], ack: RepeatAcknowledgement | undefined, at: string,
): RunRepeatRecord | undefined => {
  if (!ack) {
    if (found.length) throw new Error(repeatRefusal(period, found));
    return undefined;
  }
  const named = new Set(ack.runIds);
  const unnamed = found.filter(f => !named.has(f.run.id));
  if (unnamed.length) {
    throw new Error(
      `this run also repeats ${unnamed.map(f => `run ${f.run.id} (${f.state})`).join(', ')}, which `
      + 'is not in what was confirmed. A repeat is confirmed by naming every run it repeats, so '
      + 'read the list again and confirm the whole of it.');
  }
  const repeating = new Set(found.map(f => f.run.id));
  const notRepeated = [...named].filter(id => !repeating.has(id));
  if (notRepeated.length) {
    throw new Error(
      `${notRepeated.join(', ')} ${notRepeated.length === 1 ? 'was' : 'were'} confirmed as repeated `
      + `and this run does not repeat ${notRepeated.length === 1 ? 'it' : 'them'}, so the list that was `
      + 'read is not the list this run would act on. Take the confirmation again against what this '
      + 'run actually repeats.');
  }
  if (found.length === 0) return undefined;
  if (!ack.by.trim()) throw new Error('a repeated payroll has to be attributable to somebody');
  if (!ack.reason.trim()) {
    throw new Error('say why this run repeats another; a blank reason is not a record');
  }
  return { of: [...repeating].sort(), reason: ack.reason, by: ack.by, at };
};

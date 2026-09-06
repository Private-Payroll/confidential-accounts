import type { Hex } from './crypto.js';
import type { PayeeAddress } from '../midnight/payee-address.js';

/**
 * **NO PRODUCT PATH REACHES THIS FILE, AND THE ROWS ITS FUNCTIONS CARRY ARE NOT
 * ENFORCED HERE.** `T-227` `P2`, found 3 Sep by `SC10b`, written down by `S55`.
 *
 * **MEASURED, by grep across `src/`, `scripts/` and `contracts/` for every name
 * this module exports** — `admitRuleFor`, `AUTHORITY_KINDS`, `carriesAuthority`,
 * `startingRules`, `principal`, `admitFactor`, `removeFactor`, `canAct`,
 * `canAdmit`, `securityRung`, `mayHoldMoney`, `payableAddress`, `FactorKind`,
 * `Rung`: **the only importer in this repository is `principal.test.ts`.** Zero
 * product call sites, for all of them.
 *
 * **SO TWO REGISTER ROWS BELOW ARE ASSERTED HERE AND ENFORCED SOMEWHERE ELSE,
 * WHICH IS THE WHOLE OF WHY THIS PARAGRAPH EXISTS (rule 27, `C286`):**
 *
 *   - **`C11`** — *a principal on rung 1 may exist and may not hold money* — is
 *     `mayHoldMoney` below, and nothing in the product calls it.
 *   - **`C9`** is `payableAddress` below, and **the product enforces `C9`
 *     somewhere else entirely**: `paymentFactsFor` (`src/core/payroll.ts:1877`),
 *     whose own header says *"`C9` is enforced here rather than assumed"*. **Two
 *     implementations of one rule, and the product runs the other one.**
 *
 * **ITS 27 TESTS PROVE THIS MODULE IS INTERNALLY CONSISTENT AND PROVE NOTHING
 * ABOUT THE PRODUCT.** A round that reads `principal.test.ts` green and
 * concludes the ladder and the money gate are live is reading a file with no
 * callers. `A-5` is the row that would wire it.
 *
 * **THIS BLOCK IS AT THE TOP AND IT MOVED LINES IN A CITED FILE.** The
 * re-anchor list to TRUE CURRENT LINES is in `S55`'s build-log account.
 */
/**
 * A PRINCIPAL. A-1, and the shape decision behind it.
 *
 * A company and a person are the SAME KIND OF THING with different numbers in
 * them: a set of factors, a rule for how many are needed, and one address.
 *
 *   a company   five factors belonging to five people, and a rule of three
 *   a person    their laptop, their phone, their passkey, and a rule of one
 *
 * Having a contract on chain is a switch, not part of the definition — on for
 * companies from day one, off for a person until they want several of their own
 * devices guarding their own money.
 *
 * WHY ONE SHAPE RATHER THAN TWO. The hardest problem in this product is "who
 * gets back in when a key is lost", and the company answer already exists and
 * runs on chain: the remaining key-holders vote a new key in. Describing a
 * person the same way makes "my laptop and my passkey admit my new phone" the
 * SAME operation. Describing them differently means building that answer twice
 * and eventually noticing the second one was the first with different words.
 *
 * The type import above is deliberately `type`-only: a principal knows what an
 * address IS and this module pulls no chain code into a browser bundle.
 */

/**
 * One way of proving you are you.
 *
 * **What a factor is NOT: a wallet.** A signer's authority is a blinded leaf
 * proven inside a circuit, so the chain never learns who acted. A wallet
 * address that submits is public, and repeated across accounts it rebuilds the
 * membership graph the blinded tree exists to destroy. Authority keys and value
 * keys are two families and they never merge — `docs/accounts-and-identity.md`
 * §2, and `docs/scope-identity.md` §1.
 */
export type FactorKind =
  /** Secrets derived from an argon2id stretch of a password. Exists today. */
  | 'password'
  /** Secrets generated on, and never leaving, one device. K-3. */
  | 'device'
  /** Secrets unlocked by WebAuthn PRF. K-1, sequenced AFTER recovery. */
  | 'passkey'
  /** A wallet the person already has. Supplies VALUE keys only — never authority. */
  | 'wallet'
  /** A durable secret the person placed somewhere themselves. K-2. */
  | 'recovery-code';

export interface Factor {
  id: string;
  kind: FactorKind;
  /** What the person calls it. "My laptop", not a fingerprint. */
  label: string;
  enrolledAt: string;
  /** ed25519. Its blinded commitment is what becomes a signer leaf. */
  signingPublicKey: Hex;
  /** x25519. What a viewing key is wrapped to. */
  wrappingPublicKey: Hex;
  /*
   * THE BLINDING FACTOR IS NOT HERE, and putting it here would be a mistake
   * this repo has already made once and undone (M-99, then M-106). It lives on
   * the device and nowhere else: whoever holds a blinding plus a leaf holds the
   * leaf-to-person mapping that blinding the tree exists to destroy.
   */
}

/**
 * TWO NUMBERS, NOT ONE, and conflating them is the mistake this type exists to
 * make impossible.
 *
 * **Getting in is not the same operation as changing who can get in.** If one
 * factor can enrol another, then one stolen factor is the whole account — the
 * thief adds their own device and owns everything, and the person still has
 * theirs, so nothing looks wrong until it is far too late.
 */
export interface Rules {
  /** How many factors are needed to act. A person should not need two to read their own payslip. */
  toAct: number;
  /** How many are needed to ADMIT A NEW FACTOR. Never lower than `toAct`. */
  toAdmit: number;
}

export interface Principal {
  id: string;
  factors: readonly Factor[];
  rules: Rules;
  /**
   * Where money reaches them. `null` until their own device or wallet produces
   * one — **never chosen for them by whoever is paying.** A-2.
   */
  address: PayeeAddress | null;
}

/**
 * ONE FACTOR MAY ADMIT A SECOND; FROM TWO ONWARDS IT TAKES TWO. 17 Aug.
 *
 * Everybody starts on one device, because requiring more at sign-up is how you
 * lose the sign-up. The dangerous case is a thief adding a device to an account
 * that already has others, and that stays closed.
 */
export const admitRuleFor = (factorCount: number): number => Math.min(2, Math.max(1, factorCount));

/**
 * WHICH KINDS CARRY AUTHORITY, and this set is read by every rule rather than
 * described in a comment beside them.
 *
 * `wallet` is the one that does not. A wallet supplies VALUE keys — an address
 * to be paid at — and never authority, because a wallet address that submits is
 * public and would rebuild the membership graph the blinded tree exists to
 * destroy (`docs/accounts-and-identity.md` §2).
 *
 * **A kind that cannot act must not be counted by anything that decides whether
 * a principal CAN act.** Counting it produces `[laptop, wallet]` reading as two
 * factors: the rule to admit tightens to two, the ladder reports the top rung,
 * the money gate opens — and the real quorum is one, so no replacement can ever
 * be enrolled. It is the same defect this file already refuses forty lines below
 * for two factors sharing a signing key. **The count says two and the safety is
 * one, and nothing about the record looks wrong.**
 */
export const AUTHORITY_KINDS: ReadonlySet<FactorKind> =
  new Set<FactorKind>(['password', 'device', 'passkey', 'recovery-code']);

export const carriesAuthority = (f: Factor): boolean => AUTHORITY_KINDS.has(f.kind);

/** The default a new principal starts with: one factor, able to add a second. */
export const startingRules = (factorCount = 1): Rules =>
  ({ toAct: 1, toAdmit: admitRuleFor(factorCount) });

/** The factors that can actually satisfy a rule. Every count below uses this one. */
const authority = (p: { factors: readonly Factor[] }): readonly Factor[] =>
  p.factors.filter(carriesAuthority);

const check = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };

/**
 * The only way to make one. Everything below is an invariant rather than a
 * validation, in the sense that a principal which broke it could not be paid,
 * could not recover, or could be taken over — so it must not be possible to
 * hold one.
 */
export function principal(p: {
  id: string; factors: readonly Factor[]; rules: Rules; address?: PayeeAddress | null;
}): Principal {
  const { id, factors, rules } = p;
  check(!!id, 'a principal needs an id');
  check(factors.length > 0,
    'a principal with no factors has no way in and cannot be recovered by anybody');

  const ids = new Set(factors.map(f => f.id));
  check(ids.size === factors.length, 'two factors share an id, so one of them is invisible');

  /*
   * TWO FACTORS SHARING A SIGNING KEY IS A THRESHOLD WEAKENED IN SILENCE.
   *
   * A "two of three" whose first and second factors are the same key is a one
   * of two: one device satisfies both. The count says three, the safety is one
   * lower, and nothing about the record looks wrong. It is exactly the shape of
   * the guard that "looks like protection and is not", which this project has
   * already decided is worse than an honest absence of one.
   */
  const keys = new Set(factors.map(f => f.signingPublicKey));
  check(keys.size === factors.length,
    'two factors have the same signing key, which counts twice and protects once');

  /*
   * COUNTED IN FACTORS THAT CAN ACT, never in factors enrolled. A `wallet`
   * supplies an address and no authority, so a rule it was counted toward is a
   * rule nothing can meet.
   */
  const acting = authority({ factors }).length;
  check(acting > 0, 'a principal whose only factors are wallets has no way to act at all');
  check(Number.isInteger(rules.toAct) && rules.toAct >= 1, 'the rule to act must be at least one');
  check(rules.toAct <= acting,
    `the rule to act is ${rules.toAct} and there are ${acting} factors that can act, `
    + 'so nothing could ever be approved');
  check(Number.isInteger(rules.toAdmit) && rules.toAdmit >= 1,
    'the rule to admit a factor must be at least one');
  check(rules.toAdmit <= acting,
    `the rule to admit is ${rules.toAdmit} and there are ${acting} factors that can act, `
    + 'so no new factor could ever be added and a lost one could never be replaced');
  check(rules.toAdmit >= rules.toAct,
    'admitting a new factor must never be easier than acting, or one stolen factor '
    + 'lets somebody add their own and take the account');
  check(rules.toAdmit >= admitRuleFor(acting),
    `with ${acting} factors that can act, admitting a new one must take at least `
    + `${admitRuleFor(acting)} — one factor may admit a second, and from two onwards `
    + 'it takes two');

  return Object.freeze({
    id, factors: Object.freeze([...factors]), rules: Object.freeze({ ...rules }),
    address: p.address ?? null,
  });
}

/** Enrols a factor. The rule tightens as the second one arrives, and never loosens. */
export function admitFactor(p: Principal, factor: Factor): Principal {
  const factors = [...p.factors, factor];
  return principal({
    ...p,
    factors,
    rules: {
      ...p.rules,
      toAdmit: Math.max(p.rules.toAdmit, admitRuleFor(authority({ factors }).length)),
    },
  });
}

/**
 * Removes a factor, and REFUSES TO STRAND THE PRINCIPAL.
 *
 * The account contract already refuses to leave an account below its own
 * threshold; this is the same refusal one layer up. A principal that cannot
 * meet its own rules is not locked out temporarily — it is locked out for good,
 * with the money intact and unreachable.
 */
export function removeFactor(p: Principal, factorId: string): Principal {
  const factors = p.factors.filter(f => f.id !== factorId);
  check(factors.length !== p.factors.length, `there is no factor "${factorId}" to remove`);
  const left = authority({ factors }).length;
  check(left > 0, 'removing the last factor that can act would lock this account for good');
  check(left >= p.rules.toAdmit,
    `removing it would leave ${left} factors that can act against a rule of ${p.rules.toAdmit} `
    + 'to admit a new one, so no replacement could ever be added');
  return principal({ ...p, factors });
}

/** Whether a set of factor ids satisfies each rule. Ids, so a duplicate cannot count twice. */
const distinct = (p: Principal, factorIds: readonly string[]): number => {
  /* Only factors that can act count. A wallet presented as proof proves nothing. */
  const known = new Set(authority(p).map(f => f.id));
  return new Set(factorIds.filter(id => known.has(id))).size;
};
export const canAct = (p: Principal, factorIds: readonly string[]): boolean =>
  distinct(p, factorIds) >= p.rules.toAct;
export const canAdmit = (p: Principal, factorIds: readonly string[]): boolean =>
  distinct(p, factorIds) >= p.rules.toAdmit;

/**
 * THE LADDER — `docs/scope-identity.md` §10.
 *
 * Rung 4 (shards the person placed themselves) is NOT modelled yet and this
 * never returns it. Saying so is the point: a function that quietly reports the
 * top rung it knows about would read as "fully secured" to whatever renders it.
 */
export type Rung = 1 | 2 | 3;

export function securityRung(p: Principal): Rung {
  /* Wallets are excluded: a factor that cannot act cannot be a rung. */
  const acting = authority(p);
  const codes = acting.filter(f => f.kind === 'recovery-code').length;
  const rest = acting.length - codes;
  if (rest >= 2) return 3;
  if (codes >= 1 && rest >= 1) return 2;
  return 1;
}

/**
 * C11 — THE GROWTH LOOP MANUFACTURES ONE-DEVICE COMPANIES, and this is the gate.
 *
 * A vendor who is paid creates their own company in two clicks, which is the
 * point. What that produces is one signer, a rule of one, one device, holding
 * real money, with no quorum to recover it — the unrecoverable case arriving at
 * volume and by design rather than by accident.
 *
 * So: **a principal on rung 1 may exist, and may not hold money.** Pinned at the
 * money rather than at creation, because an empty company costs nothing to lose
 * and gating the click that makes one taxes the loop at its weakest moment for
 * no safety at all.
 *
 * NOT YET WIRED INTO COMPANY CREATION — that is A-5, and this is the definition
 * it will use rather than a second copy of the rule.
 */
export const mayHoldMoney = (p: Principal): boolean => securityRung(p) >= 2;

/**
 * C9 — BEING PAYABLE MEANS MORE THAN HAVING AN ADDRESS ON FILE.
 *
 * An employee can have an address and no working way in: the password was never
 * set, the invite was never finished, the device that made the seed was wiped
 * that afternoon. Pay them and it settles perfectly into an address whose
 * secrets nobody holds, irreversibly, the moment it lands.
 *
 * Throws rather than returning null, because every caller of this is about to
 * move money and "no address" is not a case to fall through.
 */
export function payableAddress(p: Principal): PayeeAddress {
  /*
   * THIS DOES NOT HOLD C9, AND SAYING SO IS THE POINT.
   *
   * The first version checked `factors.length > 0` — a condition `principal()`
   * already refuses, so it could never fail. A guard that looks like protection
   * and is not is worse than an honest absence of one, because the next reader
   * takes it for the answer to C9 and stops looking.
   *
   * C9 is a payee who has an address and no WORKING way in: the password was
   * never set, the invite was never finished, the device that made the seed was
   * wiped that afternoon. A factor count cannot see any of those, and neither
   * can this function — it does not know whether the address is self-custodied
   * (a wallet they already had, in which case they can always reach it) or
   * derived by us (in which case a dead factor means the money settles
   * irreversibly into an address whose secrets nobody holds).
   *
   * **What closes C9 is knowing where the address came from and whether a
   * factor has ever been used**, and that arrives with onboarding — A-2.
   */
  check(p.address !== null,
    `${p.id} has no address yet. It has to come from their own device or wallet — `
    + 'an address typed in on their behalf is the failure C7 exists for');
  return p.address!;
}

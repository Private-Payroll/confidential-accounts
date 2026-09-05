import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_MNEMONIC } from '@midnight-ntwrk/testkit-js';
import { Purposes, identityFromWords, newWords } from 'midnight-identity';
import { parseAsk } from 'midnight-identity/profile/request';
import { unlockKeyFor } from 'midnight-identity/profile/unlock';
import { FileStore } from './store-file.js';
import { SimulatedLedger, SimulatedProofSystem, SimulatedCommitments } from './ledger.js';
import { AccountService } from './account.js';
import { PayrollService, RecordingInviteDelivery } from './payroll.js';
import { seededEmployeesForHttp } from './demo.js';
import { payeeAddressFromKeys } from '../midnight/payee-address.js';
import { fromHex, newWrappingKeypair, toHex } from './crypto.js';
import { payslipKeypairForWallet, payslipKeypairFrom } from './payslip-key.js';
import { UNLOCK_PURPOSE, UNLOCK_WINDOW_MS, unlockAsk } from './wallet-unlock.js';
import { sealHandover, type SealedHandover } from './invite-handover.js';
import type { DataStore } from './store.js';
import type { Hex } from './crypto.js';
import type { PayeeAddress } from '../midnight/payee-address.js';

/**
 * **X11 §7 — THE INVITEE'S OWN DEVICE SEALS, SO A TEST HAS TO SEAL TOO.**
 *
 * `acceptInvite` has nowhere to put a plain address any more: it takes a blob
 * the service cannot open, sealed to the account's inbox public key. That key
 * reaches a real invitee inside the sealed offer; here it is looked up from the
 * invite the token belongs to, which is the same account by construction.
 */
const handedOver = (
  h: { store: DataStore },
  token: string,
  parts: { wrappingPublicKey: Hex; address: PayeeAddress; confirmation?: string | null },
): SealedHandover => {
  const invite = h.store.getInvite(token);
  if (!invite) throw new Error(`no invite for ${token} — the test is wrong, not the code`);
  const account = h.store.getAccount(invite.accountId);
  if (!account) throw new Error('no account for that invite');
  return sealHandover(
    {
      wrappingPublicKey: parts.wrappingPublicKey,
      address: parts.address.bech32,
      /* X12 §2 — the code the invitee read off their own wallet. Null here:
       * these tests are about what the SERVICE does with a handover, and the
       * comparison the code exists for is made on an admin's screen. */
      confirmation: parts.confirmation ?? null,
    },
    account.inboxPublicKey);
};

/**
 * **THE PAYSLIP KEY IS DERIVED, NOT MINTED AND KEPT.** `docs/NEXT.md` PI2b §2,
 * `C135`, `C127`, `C136`.
 *
 * ── THE ONE TEST THIS ROUND IS JUDGED ON IS `§4` ──────────────────────────
 *
 * *A person on a new device opens payslips issued before that device existed.*
 * Everything above it is the apparatus that makes that sentence mean something:
 * that the key is the person's and nobody else's, that no employer made it, and
 * that nothing anywhere wrote it down.
 *
 * ── AND WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────
 *
 * **Not one assertion about payslip SEALING was written, moved or reworded by
 * this round.** `core.test.ts` holds those — that an employee opens exactly one
 * slip, that another employee's secret does not, that the account viewing key
 * is nowhere near the path — and they pass unchanged against a key that is now
 * derived rather than random, which is the strongest available evidence that
 * the guarantee left this round exactly as it found it. `§3` below adds the
 * negatives that are about the DERIVATION specifically, and adds no others.
 */

const ORIGIN = 'https://payroll.example';
const ELSEWHERE = 'https://payroll.self-hosted.example';

const world = () => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-pi2b-')), 'db.json'));
  const accounts = new AccountService(
    store, new SimulatedLedger(SimulatedCommitments), SimulatedCommitments);
  const invites = new RecordingInviteDelivery();
  const payroll = new PayrollService(
    store, accounts, new SimulatedProofSystem(), undefined, 'undeployed', invites);
  return { store, accounts, payroll, invites };
};

const SIGNERS = [
  { name: 'Ada', role: 'admin' as const, userId: 'usr_ada' },
  { name: 'Blake', role: 'approver' as const },
];

const A_PAYEE_ADDRESS = payeeAddressFromKeys(
  { coinPublicKey: '41'.repeat(32), encryptionPublicKey: '42'.repeat(32) }, 'undeployed');

/** Somebody with a sign-in of their own, because `admit` requires one. A-11. */
const signIn = (store: { putUser: (u: any) => void }, email: string) => {
  const id = 'usr_' + email.replace(/[^a-z0-9]/gi, '_');
  store.putUser({
    id, email, name: email, keyBundle: null,
    createdAt: '2026-08-23T00:00:00.000Z',
  });
  return id;
};

/* ======================================================================== */

describe('§1 — THE DERIVATION IS A PURE FUNCTION OF A WALLET AND A COMPANY', () => {
  it('THE DERIVATION IS PINNED TO FIXED BYTES — the salt is not a thing anyone may tidy', () => {
    /*
     * **`T-196` `P1`, `SC9` `F4`, `S46`. THE ONE ASSERTION IN THIS FILE THAT IS
     * NOT SELF-REFERENTIAL.**
     *
     * Every other relation §1 pins — determinism, host-independence,
     * distinctness, not-the-parent-key, the length refusal — **stays true when
     * `PAYSLIP_SALT` changes to any other fixed string.** A changed-but-fixed
     * salt keeps this whole file green **and makes every payslip ever issued
     * unopenable**, by the person it belongs to, for good. The constant's own
     * comment (`payslip-key-derive.ts:99-101`) says *"the day it changes is the
     * day every payslip stops opening"* and nothing enforced it.
     *
     * **THE LOSS IS PAYSLIP READABILITY AND NOT FUNDS, SAID PLAINLY** so that
     * nobody has to deflate this later. It is still permanent.
     *
     * ── WHERE THESE BYTES CAME FROM — RULE 9 ──────────────────────────────
     *
     * **NOT FROM THIS REPOSITORY.** `node:crypto` — OpenSSL, not `@noble` —
     * computed `hkdfSync('sha256', ikm, utf8('midnight-payroll/payslip-wrapping/v1'),
     * <empty info>, 32)` for the secret, and OpenSSL's X25519 derived the
     * public half from it. **So this pins the SALT, the empty `info`, the
     * `sha256`, the 32-byte length and the curve** — every parameter of the
     * expansion at `payslip-key-derive.ts:132-133` — against an implementation
     * that has never seen this code.
     *
     * `contracts/test/run-keys.test.ts:171-206` is the model, and it is the
     * model for the reason written there: a schedule that only agrees with
     * itself catches an argument swap in nothing.
     */
    expect(payslipKeypairFrom(new Uint8Array(32).fill(0x11))).toEqual({
      secret: '4f9e108132ff27430f4dbe109104521f019068f7f03a3c5ab9fe9bc8f515ce7f',
      publicKey: '1cd075135b08e64262129c9b29ec29c2d6b78bbc113586feb4214b8a56c8ac65',
    });

    /* A second IKM, so a derivation that ignored its input and returned a
     * constant is not mistaken for one that is pinned. */
    expect(payslipKeypairFrom(Uint8Array.from(
      { length: 32 }, (_, i) => i + 1,
    ))).toEqual({
      secret: '6de6d8471a70a6ecfc555cfbbd7b58a524020ab45a4be930dc18aff4e7f83d2a',
      publicKey: '029390d27165ecb192191f0ec668610c24735b8bbb899ce6d0b90ab63ef77946',
    });

    /* And what a changed salt would produce — OpenSSL's answer for the same
     * IKM under `…/v2`. It is here so the test states what it is
     * discriminating between rather than only that a number changed. */
    expect(payslipKeypairFrom(new Uint8Array(32).fill(0x11)).secret)
      .not.toBe('0a03c86670830de9f3802b238d214999c446ecc8c9a438a7ad61cd578f60283f');
  });

  it('THE SAME WORDS AND THE SAME COMPANY GIVE THE SAME KEY, EVERY TIME', () => {
    /*
     * **THIS IS A DETERMINISM TEST AND IT IS NOT A RECORDED VECTOR. LABELLED
     * SO, BECAUSE BEING MISTAKEN FOR ONE IS HOW `C404` SURVIVED.**
     *
     * The input is `newWords()` — RANDOM, freshly generated on every run — so
     * there is no recorded value anywhere in it and there cannot be. It asserts
     * that the derivation is a pure function of its inputs, which is a real and
     * separate property worth keeping: it is what a caching or memoising change
     * would break. **It says nothing whatever about WHICH key comes out**, and
     * it stays green while `unlockKeyFor` returns entirely different bytes from
     * the ones every payslip already issued was sealed to. `§1b` is the test
     * that does not. `C404`, `docs/HANDOFF-SC22.md` §2 `F1`.
     */
    const words = newWords();
    expect(payslipKeypairForWallet(words, 'a1'.repeat(32), ORIGIN).secret)
      .toBe(payslipKeypairForWallet(words, 'a1'.repeat(32), ORIGIN).secret);
  });

  it('THE HOST IS NOT AN INGREDIENT — a self-hosted client derives the same key', () => {
    /*
     * The property the whole design rests on, and the reason `W3` changed what
     * the parent is derived from. A key that moved with the host would mean a
     * customer's copy of their own data opens at our address and nowhere else,
     * which is `C127` reopened by the mechanism meant to serve it.
     */
    const words = newWords();
    expect(payslipKeypairForWallet(words, 'a1'.repeat(32), ELSEWHERE).secret)
      .toBe(payslipKeypairForWallet(words, 'a1'.repeat(32), ORIGIN).secret);
  });

  it('TWO COMPANIES NEVER SHARE A KEY, and neither do two people', () => {
    const mine = newWords();
    const theirs = newWords();
    const here = payslipKeypairForWallet(mine, 'a1'.repeat(32), ORIGIN).secret;

    expect(payslipKeypairForWallet(mine, 'b2'.repeat(32), ORIGIN).secret).not.toBe(here);
    expect(payslipKeypairForWallet(theirs, 'a1'.repeat(32), ORIGIN).secret).not.toBe(here);
  });

  it('THE PAYSLIP KEY IS NOT THE KEY IT IS DERIVED FROM', () => {
    /*
     * No key in this system does two jobs. The released key opens the company
     * keyring; this one opens payslips. Holding one must not be holding the
     * other, and a one-way expansion is what makes that true rather than said.
     */
    const released = new Uint8Array(32).fill(7);
    expect(payslipKeypairFrom(released).secret).not.toBe(toHex(released));
  });

  it('and something that is not a released key is refused rather than expanded', () => {
    /*
     * A LOUD REFUSAL, because the alternative is silent: any bytes at all
     * expand into a perfectly usable keypair that nothing will ever derive
     * again — a payslip sealed to nobody, found out when somebody reads it.
     */
    expect(() => payslipKeypairFrom(new Uint8Array(31))).toThrow(/31 bytes/);
    expect(() => payslipKeypairFrom(new Uint8Array(0))).toThrow(/0 bytes/);
  });
});

/* ======================================================================== */

/**
 * **§1b — THE RECORDED DERIVATION VECTOR.** `C404` `P0`, board `D-1f`,
 * `docs/HANDOFF-SC22.md` §2 `F1`.
 *
 * ── WHAT WAS MISSING, AND WHY §1 ABOVE DID NOT COVER IT ───────────────────
 *
 * `payslip-key.ts:57` is
 * `payslipKeypairFrom(unlockKeyFor(identityFromWords(words), ask))`. **Only the
 * OUTER call is payroll's.** `identityFromWords` and `unlockKeyFor` resolve
 * into `midnight-identity`, and §1's OpenSSL vectors pin `payslipKeypairFrom`
 * alone — they stay green while the two inner functions return entirely
 * different bytes. Everything else in this file compares one derivation with
 * another derivation taken the same afternoon, which is a DETERMINISM claim and
 * not a RECORDED one: a changed `unlockKeyFor` is still deterministic, it is
 * just a different key from the one every payslip already issued was sealed to.
 * **The first signal would be an employee saying their payslip will not open,
 * and there is no recovery door.**
 *
 * ── WHAT THIS BLOCK IS AND, EXACTLY, WHAT IT IS NOT ───────────────────────
 *
 * **IT PINS TODAY'S BEHAVIOUR SO IT CANNOT CHANGE IN SILENCE. IT DOES NOT
 * ESTABLISH THAT TODAY'S BEHAVIOUR IS CORRECT.** Every literal below was read
 * off THIS code by running it and writing down what came out — that is the
 * whole mechanism and it is stated rather than hidden, because a reader who
 * mistakes it for a proof of correctness has been misled by a green test. **The
 * evidence that the derivation is RIGHT is elsewhere and is stronger: Identity's
 * `derivation.portability.test.ts` walks the same seed with `@scure/bip32` and
 * the Foundation's own testkit and compares bytes.** What is missing there is
 * that PAYROLL never runs it (`vitest.config.ts:16-18` includes `src/**`,
 * `contracts/test/**` and `scripts/**` and no `Identity` path), so a derivation
 * change fails in a repository payroll does not run, which is the same as not
 * failing. **This block moves that failure into payroll.**
 *
 * ── THREE LEVELS, SO A FAILURE SAYS WHICH HALF MOVED ──────────────────────
 *
 * A single pin on the final payslip key detects drift and cannot localise it.
 * So: the identity, then the released key, then the payslip keypair, each with
 * its own `it` and its own name — and then a fourth that ties them together.
 *
 * ── THE MNEMONIC IS A PUBLIC VALUE FOR EVER, AND THIS ONE ALREADY WAS ─────
 *
 * `TEST_MNEMONIC` is the standard BIP-39 all-`abandon` phrase with the 24-word
 * `diesel` checksum, published by the Midnight Foundation's own testkit
 * (`@midnight-ntwrk/testkit-js`, `wallet-seed.ts:19`). **IT IS A PUBLISHED TEST
 * VECTOR AND IT MUST NEVER HOLD FUNDS ANYWHERE.** It is used here rather than a
 * phrase of our own for one reason: **Identity's recorded vectors use exactly
 * this phrase** (`Identity/src/keys/derivation.portability.test.ts:2,:41-42`),
 * so the two repositories pin ONE vector and a disagreement between them is a
 * comparison rather than two unrelated numbers. It is not `newWords()` and
 * nothing in this round generated it.
 *
 * **MEASURED, NOT ASSUMED, BEFORE IT WAS WRITTEN HERE: it holds nothing.** All
 * **forty** files under `.midnight/` — the whole tree, `params/` and `sealed/`
 * included, not the twenty at the top level — were searched for this phrase,
 * for its BIP-39 entropy and for its 64-byte stretched seed. **Zero hits**, and
 * no `.command` and nothing in `scripts/` derives a wallet from it. The
 * project's own wallet comes from `.midnight/wallet.seed`
 * (`ADDRESS.command:67`). **The count in this paragraph said TWENTY until this
 * round's `test-auditor` re-measured it recursively and found forty; the
 * conclusion was unchanged and the instrument's stated reach was not.**
 *
 * ── THE NEGATIVE CONTROL — MEASURED, NOT ASSERTED (rule 40, rule 9) ───────
 *
 * **A VECTOR NOBODY HAS WATCHED FAIL IS NOT A VECTOR.** The literals below were
 * checked against a NEUTERED COPY of `midnight-identity` built outside this
 * repository — copies of `Identity/lib` and of this tree's own `core/` files in
 * a scratch directory, so **nothing in the working tree was mutated to prove
 * this** (rule 40, `C401`). A control run over pristine copies reproduced all
 * four literals exactly; then three changes of the kind `C404` names:
 *
 *   · `UNLOCK_SALT` `…/unlock/v2` → `…/v3` (a salt tidy) — **`§1b.2` and
 *     `§1b.3` both fail. `§1b.1` stays green**, which is the localisation
 *     working: the change is below the identity, and the test says so.
 *   · `UNLOCK_PARENT_INDEX` `0` → `1` (one flipped constant) — same three.
 *   · `Purposes.Unlock` `'unlock'` → `'unlock-key'` (a purpose rename, in
 *     `derivation.ts`) — **all four fail**, `§1b.1` included, because that
 *     change is above the identity rather than below it.
 *
 * **AND THREE MORE, AFTER THE TWO AUDITS, EACH AIMED AT A LINE ADDED BECAUSE
 * OF THEM:**
 *
 *   · `phraseOf`'s `normalize`/`trim`/`toLowerCase`/whitespace collapse deleted
 *     (`derivation.ts:363`) — **only the denormalised-words line in `§1b.1`
 *     fails**, and it fails by THROWING `not-a-recovery-phrase`. Every other
 *     assertion in the block stays green, which is what made that line worth
 *     rewriting: it was green through this until it was fed a phrase with
 *     something to normalise.
 *   · The company case-fold removed — **from BOTH places, because it is
 *     doubled** (`request.ts:732` and `unlock.ts:294`): only then does the
 *     upper-case company line in `§1b.3` fail. Removing either alone changes
 *     nothing, and that is recorded beside the line rather than here.
 *   · Payroll's OWN `PAYSLIP_SALT` `…/v1` → `…/v2`
 *     (`payslip-key-derive.ts:103`) — **`§1b.3` and both of its spellings fail,
 *     and so does `§1b.4`'s literal-in-literal-out line.** `§1b.1` and `§1b.2`
 *     stay green, which is the localisation reading the other way: the change
 *     is in payroll's own expansion and the block says so.
 *
 * **AND THE RESULT THAT WAS WORTH MORE THAN THE THREE PASSES: THE RELATION
 * TEST STAYED GREEN UNDER ALL THREE.** It compared two live computations, so a
 * derivation that moved moved both. **Both of this round's auditors then probed
 * it further and independently reached the same verdict** — the `test-auditor`
 * with eight mutations including a stubbed `payslip-key.ts:57`, the
 * `money-safety-auditor` by algebra — **and `§1b.4` was rewritten because of
 * it.** What is there now is literal-in, literal-out; the relation is kept
 * beneath it, labelled as adding no detection. **The literals are the whole of
 * the drift guarantee** — which is exactly the mistake `C404` is, one level
 * down, and it is written here so nobody makes it again by deleting a literal
 * that "the relation already covers".
 *
 * **THE LIMIT OF THAT CONTROL, STATED:** a neutered copy proves each assertion
 * compares the value it claims to compare, and that a change of that shape
 * moves it. **It does not prove that a future change to the real package would
 * take that path**, and nothing in a test file can.
 *
 * ── AND THE OTHER LIMIT: THIS PINS `Identity/lib`, NOT `Identity/src` ─────
 *
 * `package.json:26` is `"midnight-identity": "file:./Identity"` and every entry
 * in `Identity/package.json`'s `exports` map resolves to `./lib/…`. **So the
 * running test loads the COMPILED output, and every `unlock.ts` and
 * `derivation.ts` line number cited in this block is a `src/` path for the
 * READER — not a file this test ever evaluates.** Pinning the built package is
 * the right thing for a consumer to pin, and it is what a published tarball
 * will ship; the cost is that **a change to `Identity/src` that has not been
 * rebuilt is invisible here**, and Identity's own suite runs against `src`
 * while this runs against `lib`. Nothing bridges the two at the `unlockKeyFor`
 * level. `§1b.1`'s `5781ec70…` is the one thread that does, at the authority
 * level, and it is why that literal was taken from Identity's table rather than
 * from a run here. **Found by this round's `money-safety-auditor` and by its
 * `test-auditor`, separately.**
 */

const VECTOR_COMPANY = 'a1'.repeat(32);

/**
 * **THE ASK, BUILT EXACTLY AS `payslip-key.ts:38-55` BUILDS IT.**
 *
 * It is duplicated here rather than exported from there, and **what holds the
 * duplication to production is `§1b.2` and `§1b.3` JOINTLY, not `§1b.4`** —
 * a `vectorAsk` that drifted breaks its own literal at `§1b.2`, and a
 * production ask that drifted in a way that reached the key breaks `§1b.3`'s.
 * **THIS PARAGRAPH NAMED `§1b.4` UNTIL BOTH OF THIS ROUND'S AUDITORS MEASURED
 * IT SEPARATELY AND FOUND IT GREEN THROUGH AN ASK DRIFT** — a changed `nonce`
 * and a changed `rdns` were each probed. The correction is kept visible rather
 * than tidied away, because the sentence that stood here is exactly the kind a
 * later round quotes as a reason to delete a literal.
 *
 * **WHAT IS STILL NOT PINNED, SAID PLAINLY:** a production ask whose `nonce`,
 * `rdns`, `name` or `purpose` drifts from this one is caught by NOTHING here,
 * because none of those four reaches `unlockKeyFor`. That is a real gap and it
 * is small: those fields are the conversation's, and a key that moved with them
 * could not open yesterday's payslip, which is what `payslip-key.ts:43-48`
 * already says. Closing it needs `payslip-key.ts` to export its ask builder,
 * and this round may not change that file.
 *
 * Neither `nonce` nor `expiresAt` reaches `unlockKeyFor` — `unlock.ts:310-317`
 * uses the identity and the company and nothing else — which is what makes any
 * of this recomputable at all.
 */
const vectorAsk = () => {
  const ask = parseAsk(
    unlockAsk({
      name: 'Confidential Accounts',
      rdns: 'social.lemonade.confidential-accounts',
      purpose: UNLOCK_PURPOSE,
      nonce: 'derivation-has-no-conversation',
      expiresAt: 0 + UNLOCK_WINDOW_MS,
      company: VECTOR_COMPANY,
    }),
    ORIGIN,
    0);
  if (ask.kind !== 'unlock') throw new Error(`built a ${ask.kind}, not an unlock`);
  return ask;
};

describe('§1b — A FIXED MNEMONIC AND A FIXED COMPANY GIVE A FIXED KEY, RECORDED', () => {
  it('§1b.1 — THE IDENTITY: the words reach the same wallet they reached yesterday', () => {
    /*
     * **LEVEL ONE — `identityFromWords`, WHICH IS NOT PAYROLL'S CODE.**
     *
     * The money keys are pinned as well as the authority parent, and they are
     * not decoration: they are account 0 of the person's real wallet, they are
     * what `derivation.portability.test.ts:58`, `:62` and `:66` prove equal to
     * the Foundation's own testkit bytes (`:53` pins the 64-byte SEED they come
     * from), and a BIP-39 or HD change that moved them would move the
     * authority compartment with them. Pinning both means a failure here says
     * whether the SEED moved or only the authority expansion above it.
     */
    const identity = identityFromWords(TEST_MNEMONIC);

    /*
     * **THE PHRASE SURVIVES ITS OWN NORMALISATION — AND THE INPUT HAS TO BE
     * DENORMALISED FOR THAT SENTENCE TO MEAN ANYTHING.**
     *
     * This line read `identityFromWords(TEST_MNEMONIC).words.join(' ')` until
     * this round's `test-auditor` measured it: `TEST_MNEMONIC` is already
     * lower-case, single-spaced and clean, so `phraseOf`
     * (`Identity/src/keys/derivation.ts:361-364`) is the identity function on
     * it — **the assertion stayed GREEN with NFKD, `trim`, `toLowerCase` and
     * whitespace collapse all deleted.** Upper-cased, double-spaced and padded,
     * it is green on the code as it stands and red with those removed, which is
     * the difference between a check and a shape.
     */
    expect(identityFromWords(
      `  ${TEST_MNEMONIC.toUpperCase().split(' ').join('  ')} \n`,
    ).words.join(' ')).toBe(TEST_MNEMONIC);

    expect({
      zswap: toHex(identity.money.zswap),
      dust: toHex(identity.money.dust),
      night: toHex(identity.money.night),
    }).toEqual({
      zswap: '2beacb32905e6033722884bd597034ab8f260fa54fb59d49a40ebff8db4a6f76',
      dust: '93d9f7becac7ac27bff24c70084866e9578964aee47bcb34ef2ef8a0e009d8c2',
      night: '5542af354abce65485d9900412ff22c09d8432834decf71b44c4c45f3af9d355',
    });

    /*
     * **AND THE ONE THE PAYSLIP KEY IS ACTUALLY MADE OF.** `unlock.ts:313` is
     * `identity.authority(Purposes.Unlock, UNLOCK_PARENT_INDEX)` and
     * `UNLOCK_PARENT_INDEX` is `0` (`unlock.ts:181`); it is module-private
     * there, so the `0` is written out here rather than imported, and a change
     * to it is caught by `§1b.2` below rather than by this line.
     *
     * `Purposes.Unlock` is spelt through the constant and its VALUE is asserted
     * separately, because the purpose string is itself an HKDF domain
     * separator (`derivation.ts:128-129`): renaming the constant while keeping
     * the string is harmless, and changing the string re-keys every credential
     * in existence.
     *
     * ── WHERE THIS ONE NUMBER CAME FROM, AND IT IS NOT THIS REPOSITORY ────
     *
     * **RULE 9.** Every other literal in `§1b` was read off THIS code running
     * — stated plainly above and not dressed up as anything else. **This one
     * was not.** It is copied from Identity's own recorded vector table —
     * `Identity/src/keys/derivation.portability.test.ts:280`, the `unlock`
     * entry at index `0` — where it is computed for this same phrase by an
     * INDEPENDENT walk (`@scure/bip32` and `@noble/hashes` driven directly at
     * `:237`, not through `derivation.ts`). **It was written here BEFORE the
     * run that confirmed it, and it matched on that first run.**
     *
     * So this line is worth more than the others: it is not payroll agreeing
     * with itself, it is payroll's live `midnight-identity` agreeing with a
     * number a different repository derived by a different route. **The day the
     * two disagree, exactly one of them is wrong and this line says which
     * question to ask.**
     */
    expect(Purposes.Unlock).toBe('unlock');
    expect(toHex(identity.authority(Purposes.Unlock, 0)))
      .toBe('5781ec70bd641bfd8bb8db7fb0661258cec3153e149ae82ec74252ee29ff1b86');
  });

  it('§1b.2 — THE RELEASED KEY: this company opens with the same key it opened with', () => {
    /*
     * **LEVEL TWO — `unlockKeyFor`, WHICH IS NOT PAYROLL'S CODE EITHER.** This
     * is the value that moves if `UNLOCK_SALT` is tidied (`unlock.ts:178`), if
     * `UNLOCK_PARENT_INDEX` changes, if the company stops travelling whole, or
     * if `@noble/hashes` changes what HKDF-SHA256 means. **None of those turns
     * anything else in this file red.**
     */
    expect(toHex(unlockKeyFor(identityFromWords(TEST_MNEMONIC), vectorAsk())))
      .toBe('52e6860cd079019ac3fbdcfc30c806bb99643ecace4202e060aa42fb43aba482');
  });

  it('§1b.3 — THE PAYSLIP KEYPAIR: the key an employee\'s payslip actually opens with', () => {
    /*
     * **LEVEL THREE — THE WHOLE COMPOSED PATH, WHICH IS THE THING THAT MATTERS
     * AND THE ONE THAT LOCALISES NOTHING.** It is pinned last and read first:
     * if this is the only red line, the change is in payroll's own expansion
     * and §1's OpenSSL vectors will say so; if `§1b.1` or `§1b.2` is red too,
     * the change came from `midnight-identity`.
     */
    expect(payslipKeypairForWallet(TEST_MNEMONIC, VECTOR_COMPANY, ORIGIN)).toEqual({
      secret: '6ea2e0b5513f0eebbb40d2036327316736ce11153d187cb828a822f1a2072c37',
      publicKey: '4af82790626f053a71d120ff00dcc1a8c83aeff2cb9efd85104eb9493e87e776',
    });

    /*
     * **THE SAME LITERAL FROM THE OTHER SPELLING OF THE SAME COMPANY.** Found
     * by this round's `money-safety-auditor`, and it is `C404`'s own thesis
     * turned on `C137`: the fold that makes two spellings of one company one
     * key is pinned by `Identity/src/profile/unlock.test.ts:257-263` — **and
     * payroll does not run that file** (`vitest.config.ts:16-18`).
     * `VECTOR_COMPANY` is already lower-case, so **no literal above moves when
     * the fold goes.** This line is what dies instead.
     *
     * ── AND EXACTLY WHEN IT DIES, MEASURED RATHER THAN ASSUMED ───────────
     *
     * **THE FOLD IS DOUBLED, WHICH THE AUDIT DID NOT SAY AND THE MEASUREMENT
     * DID.** It happens twice on this path: `parseAsk` folds the company as it
     * freezes the ask (`Identity/src/profile/request.ts:732`), and `companyOf`
     * folds again inside `unlockKeyFor` (`unlock.ts:294`). Against neutered
     * copies outside this repository: **removing EITHER one alone leaves this
     * line GREEN; removing BOTH turns it RED.** So what this assertion buys is
     * not a guard on one line — it is a guard on the PROPERTY surviving, and it
     * is the only thing in payroll that would notice the property going.
     *
     * It matters because payroll's folding is not uniform: `keyring.ts` and
     * `Join.tsx` both take a company that `company-address.ts` has already
     * folded, but `payroll.ts:1473` reads `contractAddress` raw from the store
     * and passes it unfolded at `:1485`.
     */
    expect(payslipKeypairForWallet(TEST_MNEMONIC, VECTOR_COMPANY.toUpperCase(), ORIGIN).secret)
      .toBe('6ea2e0b5513f0eebbb40d2036327316736ce11153d187cb828a822f1a2072c37');

    /*
     * **AND FROM THE OTHER SPELLING OF THE SAME WALLET.** Also the
     * `money-safety-auditor`'s. `payslipKeypairForWallet` takes
     * `readonly string[] | string` (`payslip-key.ts:36`) and **every production
     * caller passes the ARRAY** — `payroll.ts:1484-1485` hands it `newWords()`
     * — while every literal above went in as a string. Two different branches
     * of `phraseOf` (`derivation.ts:361-364`), one recorded path.
     *
     * **AND WHAT THIS LINE IS NOT: A WATCHED FAILURE.** No neutering was found
     * that reds it and leaves the string spelling green — `validateMnemonic`
     * (`derivation.ts:387`) gates every route, so the realistic mutations of
     * the array branch (`join('')`, a reorder, `String(words)`) produce an
     * invalid phrase and throw `not-a-recovery-phrase` LOUDLY rather than
     * deriving a different key. **This is coverage of a shape, not a guard, and
     * it is written down as one** — which is why it is a line and not a section.
     */
    expect(payslipKeypairForWallet(TEST_MNEMONIC.split(' '), VECTOR_COMPANY, ORIGIN).secret)
      .toBe('6ea2e0b5513f0eebbb40d2036327316736ce11153d187cb828a822f1a2072c37');
  });

  it('§1b.4 — THE TWO RECORDED VALUES MEET: literal in, literal out, no live recompute', () => {
    /*
     * **THE JOIN BETWEEN `§1b.2` AND `§1b.3`, WITH NOTHING LIVE ON EITHER SIDE
     * OF IT.** `§1b.2`'s released key goes in as a written-down constant;
     * `§1b.3`'s payslip keypair is what must come out. Neither operand is
     * recomputed from the mnemonic, so this is the one line in the block whose
     * two halves cannot move together.
     *
     * **IT REPLACED A LINE THAT COULD NOT FAIL, AND THE REPLACEMENT IS THE
     * FINDING RATHER THAN THE FIX.** What stood here asserted
     * `payslipKeypairFrom(unlockKeyFor(…))` equals `payslipKeypairForWallet(…)`
     * — both sides computed live from the same mnemonic through the same code,
     * so a derivation that moved moved both. **This round's `test-auditor`
     * probed it eight ways and it was GREEN in all eight, including one that
     * replaced `payslip-key.ts:57` with a hard-coded return so the product
     * function derived nothing at all.** The `money-safety-auditor` reached the
     * same conclusion by algebra, independently. **An assertion nobody has
     * watched fail is the class `§2`'s own note below records this file
     * shipping once already** — the `S29` regex that could not match the value
     * it was looking for.
     *
     * **WHAT THIS ONE IS MEASURED TO CATCH:** payroll's own `PAYSLIP_SALT`
     * moving (`payslip-key-derive.ts:103`), which reds it and `§1b.3` together
     * — and any future edit that re-pins `§1b.3` without re-deriving, because
     * the two literals would then disagree here.
     */
    expect(payslipKeypairFrom(
      fromHex('52e6860cd079019ac3fbdcfc30c806bb99643ecace4202e060aa42fb43aba482'),
    )).toEqual({
      secret: '6ea2e0b5513f0eebbb40d2036327316736ce11153d187cb828a822f1a2072c37',
      publicKey: '4af82790626f053a71d120ff00dcc1a8c83aeff2cb9efd85104eb9493e87e776',
    });

    /*
     * **AND THE RELATION, KEPT — LABELLED FOR WHAT IT IS RATHER THAN DELETED.**
     * It records that the product's composed path IS `payslipKeypairFrom`
     * applied to the key that ask releases. **It adds no detection: it is green
     * under every derivation change, under an ask drift, and under a stubbed
     * product function.** It is documentation that executes, and it is worth
     * its two lines only because the next reader will otherwise reconstruct the
     * relation by hand. **Nothing may be deleted above on the ground that this
     * covers it.**
     */
    expect(payslipKeypairFrom(unlockKeyFor(identityFromWords(TEST_MNEMONIC), vectorAsk())))
      .toEqual(payslipKeypairForWallet(TEST_MNEMONIC, VECTOR_COMPANY, ORIGIN));
  });
});

describe('§2 — NOBODY WRITES THE SECRET DOWN, INCLUDING US', () => {
  it('THE SEED DERIVES THE KEY AND NO LONGER INVENTS ONE', async () => {
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { secret } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);

    /*
     * ASSERTED AGAINST THE DERIVATION, NOT AGAINST A SHAPE. A random secret is
     * 64 hex characters too — which is exactly why `C140` exists one level up —
     * so the only claim worth making is that this key is what those words and
     * that company produce.
     */
    expect(secret.words).toBeDefined();
    expect(secret.wrappingSecret).toBe(
      payslipKeypairForWallet(
        secret.words!, h.store.getAccount(account.id)!.contractAddress!, ORIGIN).secret);
  });

  it('THE SECRET IS IN NO STORED RECORD ANYWHERE — not the roster, not the run', async () => {
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { employee, secret } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const derived = payslipKeypairForWallet(
      secret.words!, h.store.getAccount(account.id)!.contractAddress!, ORIGIN);
    await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    /*
     * **SEARCHED IN THE RAW TEXT, NOT THE REDACTED TEXT, AND THE FIRST VERSION
     * OF THIS TEST HAD IT THE WRONG WAY ROUND.**
     *
     * `redactHex` blanks every hex run of 32 characters or more, which is what
     * makes searching for a SALARY sound (M-101). A wrapping secret is 64 hex
     * characters — so redacting first deletes the very thing being looked for,
     * and the assertion passes whatever the store contains. `redact.ts`'s own
     * header says so: long values must be searched for literally, and at 64
     * characters a chance collision is not a thing that happens.
     */
    const raw = JSON.stringify((h.store as unknown as { data: unknown }).data);
    /*
     * **TWO POSITIVE CONTROLS BEFORE THE ABSENCE**, because an absence test
     * over the wrong string passes perfectly. The store really was read, and it
     * really does hold this person's key material — the PUBLIC half.
     */
    expect(raw).toContain(employee.id);
    expect(raw).toContain(derived.publicKey);
    expect(raw).not.toContain(secret.wrappingSecret);

    /*
     * **AND THE WORDS, AS A PHRASE RATHER THAN ONE AT A TIME.** A BIP-39 word
     * list contains `name`, `asset`, `type`, `index` and `credit`, every
     * one of which is a legitimate key in this store — so asserting word by
     * word is a test that fails at random on correct code, which is M-101
     * wearing different clothes. The whole phrase cannot collide with anything.
     */
    expect(raw).not.toContain(secret.words!.join(' '));
  });

  it('THE COMPANY HOLDS ONLY THE PUBLIC HALF', async () => {
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { employee, secret } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);

    const onRoster = h.payroll.person(employee.id, viewingKey)!;
    const derived = payslipKeypairForWallet(
      secret.words!, h.store.getAccount(account.id)!.contractAddress!, ORIGIN);
    expect(onRoster.wrappingPublicKey).toBe(derived.publicKey);
    expect(JSON.stringify(onRoster)).not.toContain(derived.secret);
  });

  /*
   * ──────────────────────────────────────────────────────────────────────────
   * **THIS TEST WAS RED ON PURPOSE FOR ONE ROUND, AND `S29` TOOK OPTION (a).**
   * `C303`, `C312`, `T-63`.
   *
   * `S28` could not close it: the assertion is about a property OF the
   * projection `seedDemo` returns, `seedDemo` refuses as its first statement
   * (`C292`, `S26`), and a tests-only round may not edit `src/core/demo.ts`.
   * It wrote three ways out with none marked correct (rule 20). (a) was
   * *extract the projection into a callable of its own and drive that*.
   *
   * **THAT IS WHAT THIS NOW DOES, AND THE RULE IS UNCHANGED RATHER THAN
   * LOWERED.** `seededEmployeesForHttp` is the same four fields, listed and not
   * spread, from the same inputs; nothing about what crosses the wire moved.
   * What moved is that the rule can be asserted without seeding a company that
   * cannot be seeded — and the input below is a REAL `hireDirect` payload with
   * real words in it, not a hand-built object, so a new secret appearing on
   * `EmployeeSecret` is still caught by this test rather than by nobody.
   * ──────────────────────────────────────────────────────────────────────────
   */
  it('THE SEED\'S HTTP PAYLOAD CARRIES NO MNEMONIC — a wallet is not a wrapping secret', async () => {
    /*
     * **`C45`, AND THE SIZE OF THE SECRET IS THE WHOLE POINT.** `/api/demo/seed`
     * already hands back every signer's secrets, which is what makes the demo
     * walkable alone. A wrapping secret opens payslips; **a mnemonic is a whole
     * wallet, that person's money keys included.** `seededEmployeesForHttp`
     * lists the fields it returns instead of spreading them, so a new secret on
     * `EmployeeSecret` cannot leave THROUGH THIS PROJECTION without somebody
     * typing a line.
     *
     * **AND THAT IS ONE OF THE TWO ROUTES THAT RETURN AN `EmployeeSecret` TO
     * THE WIRE.** `S29`, found by its own `money-safety-auditor`.
     * `POST /api/accounts/:id/payroll` returns `payroll.createRun`'s result
     * WHOLE — `{ run, secrets: EmployeeSecret[] }` — with no projection between
     * the interface and `res.json`. Nothing leaks there today, because the ad
     * hoc branch that mints a secret sets three fields and `words` is absent by
     * construction; **but a field added to `EmployeeSecret` leaves by that route
     * on the next deploy with nobody typing anything.** Rule 27, `C286`: the
     * property holds because nobody has written the code that would break it.
     * The route is a row; the two assertions below are what this file can hold
     * without one.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const hired = [
      { name: 'Dana', email: 'dana@a.co', title: 'Eng',     asset: 'GBP', baseAmount: 9400_00n },
      { name: 'Eli',  email: 'eli@a.co',  title: 'Finance', asset: 'GBP', baseAmount: 7100_00n },
    ].map(spec => h.payroll.hireDirect(account.id, spec, viewingKey));

    /*
     * **POSITIVE CONTROLS BEFORE THE ABSENCE**, because an absence test over a
     * payload that never held the secret passes perfectly, and because the
     * probe has to be the shape the secret would really arrive in.
     *
     * **AND THE FIRST ONE FAILED THE ROUND THAT WROTE IT, WHICH IS WHY IT IS
     * HERE.** `S29`; the register row is described in `BACKLOG.md` for the
     * controller and is deliberately not numbered here (rule 16). The assertion
     * this test carried until now was
     * `expect(body).not.toMatch(/\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\b/)` — a
     * space-separated phrase. **`words` is a string ARRAY**, so a `...e.secret`
     * would put `"words":["dove","radar",…]` into the body and that regex would
     * not match one character of it. The rule was held by
     * `not.toHaveProperty('words')` alone; the phrase probe was decorative and
     * had been quoted as evidence for a round. The control below is what says
     * so: it fails if the probe cannot find the secret when the secret IS
     * there.
     *
     * The phrase form is kept as well, because a future field that joins the
     * words is the other way this leaves — and both forms are now controlled.
     */
    const asArray = (e: { secret: { words?: string[] } }) => JSON.stringify(e.secret.words);
    const asPhrase = (e: { secret: { words?: string[] } }) => e.secret.words!.join(' ');
    const raw = JSON.stringify(hired);
    for (const e of hired) expect(e.secret.words).toHaveLength(24);
    for (const e of hired) expect(raw).toContain(asArray(e));
    expect(asPhrase(hired[0])).toMatch(/\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\b/);

    const employees = seededEmployeesForHttp(hired);
    const body = JSON.stringify(employees);

    expect(employees.length).toBe(hired.length);
    /*
     * **THE FIELD LIST ITSELF, ASSERTED.** Without this the "somebody has to
     * type a line" half of the rule is watched by nothing: adding a fifth field
     * to the LISTED projection leaves every other assertion here green, which
     * this round's `test-auditor` measured. Now an addition has to be read and
     * re-approved rather than merely typed.
     */
    expect(Object.keys(employees[0]).sort())
      .toEqual(['employeeId', 'name', 'title', 'wrappingSecret']);
    for (const e of employees) {
      expect(e).not.toHaveProperty('words');
      /* And a wrapping secret really did come through — the SHAPE of one, which
       * is all this line checks; §4 below is what proves one opens a payslip. */
      expect(e.wrappingSecret).toMatch(/^[0-9a-f]{64}$/);
    }
    /* Neither form of the mnemonic is anywhere in the payload. */
    for (const e of hired) {
      expect(body).not.toContain(asArray(e));
      expect(body).not.toContain(asPhrase(e));
    }
    expect(body).not.toMatch(/\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\b/);
  });

  it('AN AD HOC PAYEE STILL GETS A MINTED KEY, AND THE TYPE SAYS SO', async () => {
    /*
     * **THE ONE PLACE `C135` IS STILL TRUE, PINNED SO IT CANNOT SPREAD
     * QUIETLY.** An ad hoc run pays somebody with no roster entry, so there is
     * no handover, no wallet and nothing to derive from. The secret is returned
     * once and `words` is ABSENT — which is the difference being visible in the
     * type rather than in a comment.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { secrets } = await h.payroll.createRun(account.id, '2026-07', [
      { name: 'Vendor', asset: 'GBP', amount: 50_00n },
    ], viewingKey);

    expect(secrets).toHaveLength(1);
    expect(secrets[0].wrappingSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets[0].words).toBeUndefined();
  });
});

describe('§3 — THE KEY OPENS THIS PERSON\'S PAYSLIP AND NOTHING ELSE OPENS IT', () => {
  it('A COMPANY\'S OWN KEYS DO NOT OPEN A PAYSLIP — not the viewing key, not a signer\'s',
    async () => {
      /*
       * **THE ONE THAT MATTERS.** Decided 23 Aug: the architecture stands as
       * it is. The employer holds the viewing key that opens the
       * roster, the runs and the policy, and it must not open one payslip.
       * `scripts/mutate-payslip-key.mjs` 05 wraps the slip key to a company-held
       * key instead of the payee's, and this is what dies.
       */
      const h = world();
      const { account, viewingKey, secrets } = await h.accounts.create('Acme', SIGNERS, 1);
      const { employee } = h.payroll.hireDirect(account.id, {
        name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
      }, viewingKey);
      const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

      expect(() => h.payroll.employeeView(run.id, employee.id, viewingKey))
        .toThrow(/that key cannot open this payslip/);
      expect(() => h.payroll.employeeView(run.id, employee.id, secrets[0].wrappingSecret))
        .toThrow(/that key cannot open this payslip/);
    });

  it('ANOTHER PERSON\'S DERIVED KEY DOES NOT OPEN IT EITHER', async () => {
    /*
     * `scripts/mutate-payslip-key.mjs` 04 takes the person's own key out of the
     * expansion, so every employee derives the same keypair. This is what
     * notices — and it notices through the real product path rather than by
     * comparing two derivations, because equal keys are only a defect once
     * somebody's payslip opens with the wrong one.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const dana = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const sam = h.payroll.hireDirect(account.id, {
      name: 'Sam', email: 's@a.co', title: 'Design', asset: 'GBP', baseAmount: 200_00n,
    }, viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    expect(h.payroll.employeeView(run.id, dana.employee.id, dana.secret.wrappingSecret)
      .payslip).toBeTruthy();
    expect(h.payroll.employeeView(run.id, sam.employee.id, sam.secret.wrappingSecret)
      .payslip).toBeTruthy();

    /*
     * **BOTH DIRECTIONS, AND THE SECOND ONE IS NOT SYMMETRY FOR ITS OWN SAKE.**
     * A run seals slips in roster order, so a defect that wraps every slip to
     * the FIRST payee's key leaves the first person's own slip working
     * perfectly — and a test that only ever reads downwards would pass while
     * everybody else's pay was readable by one colleague.
     * `scripts/mutate-payslip-key.mjs` 05 is exactly that, and this line is
     * what dies.
     */
    expect(() =>
      h.payroll.employeeView(run.id, dana.employee.id, sam.secret.wrappingSecret))
      .toThrow(/that key cannot open this payslip/);
    expect(() =>
      h.payroll.employeeView(run.id, sam.employee.id, dana.secret.wrappingSecret))
      .toThrow(/that key cannot open this payslip/);
  });

  it('AND A KEY DERIVED FOR ANOTHER COMPANY DOES NOT OPEN IT', async () => {
    /*
     * The same wallet, the same person, the wrong company. This is what stops
     * one employer's released key becoming a skeleton key across every employer
     * that person has ever had.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { employee, secret } = h.payroll.hireDirect(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    const elsewhere = payslipKeypairForWallet(secret.words!, 'b2'.repeat(32), ORIGIN);
    expect(() => h.payroll.employeeView(run.id, employee.id, elsewhere.secret))
      .toThrow(/that key cannot open this payslip/);
  });

  it('THE EMPLOYER NEVER GENERATES THE EMPLOYEE\'S KEY ON THE REAL PATH', async () => {
    /*
     * `payroll.ts:221-223` says why: an employer that generated it could read
     * the slip. On the real path the roster entry is `pending` and carries NO
     * key at all until the person's own device sends a public half — so there
     * is a state, reachable and asserted, in which the company has hired
     * somebody and can seal nothing to them.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const { employee } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey, 'usr_ada');

    const onRoster = h.payroll.person(employee.id, viewingKey)!;
    expect(onRoster.status).toBe('pending');
    expect(onRoster.wrappingPublicKey).toBeNull();
    await expect(h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey))
      .rejects.toThrow(/Dana/);
  });
});

describe('§4 — A NEW DEVICE OPENS PAYSLIPS ISSUED BEFORE IT EXISTED', () => {
  it('A WALLET REBUILT FROM ITS WORDS ALONE OPENS A PAYSLIP ISSUED BEFORE THAT DEVICE EXISTED',
    async () => {
      /*
       * **THE TEST THIS ROUND IS JUDGED ON.** It is the whole difference
       * between a derived key and a stored one, and it is written as the
       * sequence it really is rather than as two derivations compared.
       *
       * DEVICE ONE hands over a public key derived from the person's wallet,
       * through the real onboarding — invite, accept, admit. The company then
       * issues a payslip. **Nothing about device one is carried forward past
       * that point except the twenty-four words**, which is what a person has
       * when their laptop is gone.
       */
      const h = world();
      const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
      const company = h.store.getAccount(account.id)!.contractAddress!;

      const words = TEST_MNEMONIC;
      const deviceOne = payslipKeypairForWallet(words, company, ORIGIN);

      const { employee, sentTo } = h.payroll.invite(account.id, {
        name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 6_200_00n,
      }, viewingKey, 'usr_ada');
      const dana = signIn(h.store, 'd@a.co');
      h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
        /* ONLY THE PUBLIC HALF LEAVES THE DEVICE. */
        wrappingPublicKey: deviceOne.publicKey,
        address: A_PAYEE_ADDRESS,
      }), dana);
      h.payroll.admit(employee.id, viewingKey, 'usr_ada');

      const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

      /*
       * DEVICE TWO. A laptop that did not exist when that payslip was sealed,
       * holding nothing: no keyring, no bundle, no backup, no copy of
       * `deviceOne`. It is handed the words and the company's own address —
       * which is public, and which `companyForSession` would give it — and it
       * works the key out.
       */
      const secondDevice = payslipKeypairForWallet(words, company, ELSEWHERE);

      const view = h.payroll.employeeView(run.id, employee.id, secondDevice.secret);
      expect((view.payslip as { amount: bigint }).amount).toBe(6_200_00n);
      expect((view.payslip as { period: string }).period).toBe('2026-07');
      expect(view.runId).toBe(run.id);
    });

  it('AND A DIFFERENT WALLET ON THAT SECOND DEVICE OPENS NOTHING', async () => {
    /*
     * The other half of the same claim, and an absence test is worth nothing
     * without it: the one above would pass just as happily if `employeeView`
     * had stopped checking anything at all.
     */
    const h = world();
    const { account, viewingKey } = await h.accounts.create('Acme', SIGNERS, 1);
    const company = h.store.getAccount(account.id)!.contractAddress!;

    const { employee, sentTo } = h.payroll.invite(account.id, {
      name: 'Dana', email: 'd@a.co', title: 'Eng', asset: 'GBP', baseAmount: 6_200_00n,
    }, viewingKey, 'usr_ada');
    h.payroll.acceptInvite(h.invites.tokenFor(sentTo), handedOver(h, h.invites.tokenFor(sentTo), {
      wrappingPublicKey: payslipKeypairForWallet(TEST_MNEMONIC, company, ORIGIN).publicKey,
      address: A_PAYEE_ADDRESS,
    }), signIn(h.store, 'd@a.co'));
    h.payroll.admit(employee.id, viewingKey, 'usr_ada');
    const { run } = await h.payroll.createRunFromRoster(account.id, '2026-07', viewingKey);

    const somebodyElse = payslipKeypairForWallet(newWords(), company, ORIGIN);
    expect(() => h.payroll.employeeView(run.id, employee.id, somebodyElse.secret))
      .toThrow(/that key cannot open this payslip/);
    /* And a key that was never derived from anything at all. */
    expect(() => h.payroll.employeeView(run.id, employee.id, newWrappingKeypair().secret))
      .toThrow(/that key cannot open this payslip/);
  });
});

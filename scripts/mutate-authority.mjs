#!/usr/bin/env node
/**
 * **THE ANSWERS THIS PROCESS IS NOT ENTITLED TO PRODUCE.**
 *
 * Grouped by what it guards, not by which round produced it. Two subjects, and
 * they are the same subject one level apart:
 *
 *   · **WHO SAYS A ROUND IS APPROVED** — the count and the bar come off one
 *     captured `LedgerStatus`, and "we could not read the chain" is a third
 *     outcome rather than a quiet "not enough".
 *   · **WHO SAYS AN ACCOUNT CAN STILL APPROVE ANYTHING AT ALL** — the three
 *     guards that stand in front of a removal, a rotation and a threshold
 *     round measure against the contract's threshold and the contract's seat
 *     count, and a guard that cannot read either REFUSES.
 *   · **WHO CHOOSES THE IMPLEMENTATION** — one selector, and the detector that
 *     says so is not blind.
 *   · **WHETHER A ROUND CAN HALF-HAPPEN, AND WHICH TRANSACTION IT IS RECORDED
 *     UNDER** — the money moving and the state moving are ONE operation, and
 *     the identifier kept against a completed round is that operation's.
 *
 *
 * **WHY THESE ARE ONE FILE AND NOT TWO.** Both are about a place being the only
 * place entitled to give an answer, and about what happens when a second place
 * quietly starts giving one. `core/account.ts` is where a local count used to
 * decide; `wiring/selection.ts` is where a local import used to decide. A
 * harness named after either round would have put one of them behind a name
 * that says nothing about the other, and a round number is not a subject.
 *
 * **AND `R6` BELONGS HERE FOR THE SAME REASON, ONE STEP FURTHER ON.** Once the
 * chain has said a round is approved, something has to be entitled to say the
 * round HAPPENED — and while settling and executing were two calls, two
 * different transactions could each answer half of that, with the record
 * naming the one that did not move the money. `core/ledger.ts` is where a
 * second reference used to be minted.
 *
 * **WHY THIS IS A HARNESS AT ALL.** The FIVE THIS FILE STARTED WITH were each
 * performed by hand, watched once, and quoted in `docs/build-log.md` — `R4`'s
 * three under VERIFIED, and `R2`'s and `R3`'s allow-list control, which each ran
 * in a throwaway replication OUTSIDE the working tree. **A proof watched once
 * has no alarm.** (**The count below is not five and this sentence used to read
 * as though it were.** Entries come and go, each with its reason;
 * the harness derives the count from the array and prints it — **and since
 * `S56` this sentence writes none either. It said THIRTEEN against an array of
 * TWENTY-TWO, in the same breath. `T-312`.**) **THE VALUABLE HALF OF THE REPORT
 * IS THE TWO NUMBERS THAT ARE NOT `survived`:** a mutation that COULD NOT BE
 * APPLIED has guarded nothing since; one that MEASURED NOTHING proves nothing.
 *
 * ── 04 AND 05 MUTATE A CHECKER AND THAT IS DELIBERATE ────────────────────
 *
 * `one-wiring-point.test.ts` reads source text rather than exercising code, so
 * the thing that can rot is the CHECKER, not the product. Precedent in this
 * repository: `scripts/mutate-web-wasm.mjs` mutates
 * `src/web/no-wasm-in-the-page.test.ts` for the same reason.
 *
 * **05 is the defect `R2` actually found, made standing.** Its stripper once
 * collapsed comments onto one line, and the test PASSED while the `file:line`
 * it would have printed named the wrong line. A detector whose green is cheap
 * needs a standing control, and the control is the presence assertion: making
 * the block-comment pattern greedy blanks everything from a file's FIRST
 * comment-opener to its LAST comment-closer, and the selector stops naming two
 * of the three.
 *
 * THREE REFUSALS, ALL BORROWED FROM `MUTATE.command`:
 *
 *   · **stale mutation** — the text it edits is not in the file any more.
 *   · **ambiguous target** — the text appears more than once.
 *   · **stale expectation** — a test it names is not in the suite any more.
 *
 * AND THE ONE THAT MATTERS: **a mutation that SURVIVES is a hole.**
 *
 * Usage:  node scripts/mutate-authority.mjs [--only=1,3] [--report=PATH]
 */
import { execFileSync } from 'node:child_process'; import { createHash } from 'node:crypto'; import { fileURLToPath } from 'node:url'; // THREE ON ONE LINE ON PURPOSE — see `RUN_AS_DOOR` below. Do not split them.
import { readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const ROOT = process.cwd();
/*
 * **FOUR, NOT FIVE. `S29`.** `src/core/settling-and-executing-are-one.test.ts`
 * was the fifth and is not on disk — `C292`/`S26` moved it to
 * `_to_delete/S26-C292/`. It stayed in this list, and `AUTHORITY-CHECK.command`
 * printed it on screen as one of the files these mutations are judged against,
 * for five days. The four mutations that named tests inside it (`15`-`18`) are
 * deleted above, with their reason.
 */
/*
 * **AND A FIFTH SINCE `S33`, WHICH IS THE SAME SUBJECT ONE LEVEL LOWER DOWN.**
 * Everything above asks who is entitled to answer *is this round
 * approved*. The signer leaf asks who is entitled to answer *may this device
 * approve at all* — it is the value the on-chain tree holds and the value
 * `requireSigner()` recomputes, and the two were stored in different places and
 * compared by nobody. A wrong answer here does not lose a round; it loses a
 * seat, permanently, and enough seats is an account nobody can move money out
 * of.
 */
export const SUITES = [
  'src/core/the-threshold-is-the-chain-s.test.ts',
  'src/core/the-guards-cannot-strand-an-account.test.ts',
  'src/core/a-vault-s-own-threshold.test.ts',
  'src/wiring/one-wiring-point.test.ts',
  'src/core/signer-leaf.test.ts',
  /*
   * **A CONTRACT SUITE IN THIS HARNESS, ADDED BY `S34`.**
   *
   * Every other suite here is isomorphic `core/`. This one is not, and it is
   * here because the binding it holds cannot be held anywhere else: `C328` was
   * the product and the CONTRACT disagreeing about what a signer's public
   * identity is, and only a test that seats what the product writes and then
   * acts through the real circuits can die when they part again. A mutation
   * answered by a mirror of two `pureCircuits` calls is a mutation that
   * survives — measured.
   */
  'contracts/test/what-a-signer-is.test.ts',
  /* The invite path's ordering and its leaf, out of the screen so a test can
   * drive them. */
  'src/web/accept-seat.test.ts', 'src/core/core.test.ts', 'src/midnight/ledger.test.ts', // EIGHTH — S67, T-286. NINTH — S74, T-358: the maintenance boundary, tier 2 of the money-path set, which this corpus targeted at no entry at all. Both line-neutral on purpose: `edges.json` pins `:542` below and a suite added on its own line moves it. See `RUN_AS_DOOR`.
];
const OUT = join(ROOT, 'logs', 'mutate-authority');

/** file, what it breaks, the exact text, its replacement, the tests that must die. */
export const MUTATIONS = [
  {
    id: 1,
    binding: 'THE APPROVAL ANSWER COMES OFF THE LEDGER, NOT OFF A LOCAL COUNT',
    file: 'src/core/account.ts',
    says: 'the read of the boundary is replaced by our own signature count against our own '
      + 'copy of the threshold, which is precisely the behaviour R4 deleted — and it is '
      + 'invisible to any test where the two sources happen to agree',
    /*
     * **UPDATED BY `R5`, AND AGAIN BY `S52`.** `R5` gave the call a vault, this
     * entry went STALE, and the run reported `1 not run` — the alarm this file
     * exists to be, fired by the round that caused it.
     *
     * `S52`/`T-216` then took `evaluatePolicy`'s pairing guard and
     * `ChainApprovals.vault` away together — the comparison was a value against
     * itself and could never fire — so the replacement no longer carries
     * `vault: proposal.vault`. **The binding under test is unchanged.** `C377`
     * moved the `from:` line into `recordStanding` without altering it; one.
     */
    from: '    const chain = approvalsOnChain(status, proposal.chainId, proposal.vault);',
    to: "    const chain = { state: 'read', approvals: proposal.approvals.length, threshold: account.policy.threshold };",
    kills: [
      'ignores our own copy of the threshold when somebody lowers it',
      'says so when the ledger reports no status at all',
      'says so when the ledger answers but does not carry the round',
    ],
  },
  {
    id: 2,
    binding: '"WE DO NOT KNOW" IS NOT "NOT ENOUGH APPROVALS"',
    file: 'src/core/account.ts',
    says: 'the unknown outcome is merged back into a short one carrying invented counts, so '
      + 'a chain we could not read is reported as a round the signers have not finished — '
      + 'two facts with opposite answers, told apart by nothing',
    from: "  if (chain.state === 'unknown') return { blocked: false, approval: { state: 'unknown', why: chain.why } };",
    to: "  if (chain.state === 'unknown') return { blocked: false, approval: { state: 'short', approvals: 0, threshold: p.threshold } };",
    kills: [
      'says so when the ledger reports no status at all',
      'says so when the ledger answers but does not carry the round',
    ],
  },
  /*
   * ── 03 IS DELETED, WITH ITS REASON. ──────────────────────────────────────
   *
   * **IT TARGETED `execute`'s UNKNOWN ARM, AND `execute` IS GONE FOR GOOD.**
   * `C292`/`S26` deleted `AccountService.execute`; `src/core/account.ts:2420`
   * and `:2469` are the two comments that stand where it was.
   *
   * Its own reason for existing was precise and is worth keeping visible:
   * running `02` showed that vitest stops a test at its first failing
   * expectation, so `02` killed both *we do not know* tests on their
   * `approvalRound` line and **the `execute` half of each had never been
   * watched to fail.** `03` was aimed at that branch alone to make those two
   * assertions load-bearing.
   *
   * `S28` rewrote `src/core/the-threshold-is-the-chain-s.test.ts` onto the
   * current contract and could not bring those assertions back — the sentence
   * *"cannot tell whether this round has reached its threshold"* exists nowhere
   * in `src/` any more. **So the assertions `03` existed to prove are gone
   * rather than pending, and a mutation that refuses as stale for ever is a row
   * in a report that certifies nothing.** `T-79`'s *Done when* offers deletion
   * with the reason or a retarget at whatever decides an unreadable round at
   * the moment a payment is claimed; nothing decides that today, so it is the
   * first.
   *
   * **WHAT IS NOW UNCOVERED, SAID PLAINLY RATHER THAN LOST WITH THE ROW:**
   * `01` and `02` both kill their tests on the `approvalRound` assertion, so
   * whatever those tests say about an unreadable round AFTER that line is
   * unwatched again — the exact hole `03` was written to close.
   */
  {
    id: 6,
    binding: 'A REMOVAL IS MEASURED AGAINST THE CONTRACT\'S THRESHOLD, NOT OUR COPY',
    file: 'src/core/account.ts',
    says: "departing() compares the survivors against `account.policy.threshold` again, so a "
      + 'copy that has drifted BELOW the contract\'s value waves through the removal that '
      + 'strands the account — and nothing goes wrong until the next approval, which may be '
      + 'a month later',
    from: '    if (survivors < bar.threshold) {',
    to: '    if (survivors < account.policy.threshold) {',
    kills: [
      'refuses a removal our stale copy of the threshold would have allowed',
    ],
  },
  {
    id: 7,
    binding: 'AND SO IS A ROTATION THAT DROPS SEVERAL SIGNERS AT ONCE',
    file: 'src/core/account.ts',
    says: 'the multi-removal guard — the one whose own comment says refusing is not '
      + 'politeness — goes back to our copy of the threshold, one layer above the removal '
      + 'guard and with the same result',
    from: '    if (stillSeated < rule.threshold) {',
    to: '    if (stillSeated < account.policy.threshold) {',
    kills: [
      'refuses a rotation our stale copy of the threshold would have allowed',
    ],
  },
  {
    id: 8,
    binding: 'THE SEATS A THRESHOLD MAY NOT EXCEED ARE THE ONES THE LEDGER HOLDS',
    file: 'src/core/account.ts',
    says: 'the mirror-image guard counts our own roster again, so a row we believe in and '
      + 'the tree does not lets a threshold be proposed above the seats that exist — the '
      + 'same stranded account reached from the other side',
    from: '    const seated = onChain.signerCount;',
    to: "    const seated = account.signers.filter(sg => sg.status === 'active').length;",
    kills: [
      'refuses a threshold above the seats the LEDGER holds, not the rows we hold',
    ],
  },
  {
    id: 9,
    binding: 'AND SO IS "THE THRESHOLD IS ALREADY THAT", THE SECOND READ IN THAT METHOD',
    file: 'src/core/account.ts',
    says: 'the no-op check compares against our copy again, so a stale number refuses a '
      + 'change the company is entitled to make and tells them it has already happened',
    from: '    if (newThreshold === onChain.threshold) {',
    to: '    if (newThreshold === account.policy.threshold) {',
    kills: [
      'allows the change our stale copy would have called a no-op',
    ],
  },
  {
    id: 10,
    binding: 'IN A GUARD, "WE DO NOT KNOW" MUST NOT BECOME "GO AHEAD"',
    file: 'src/core/account.ts',
    says: 'an unreadable status is answered with a fabricated permissive rule instead of a '
      + 'refusal, which is the exact failure R4 forbade on the approval path arriving in '
      + 'the direction that strands an account rather than the one that stalls a round',
    from: "  if (seating.state === 'read') return seating;\n  throw new Error(",
    to: "  if (seating.state === 'read') return seating;\n  return { threshold: 1, signerCount: 99 };\n  throw new Error(",
    kills: [
      'refuses a removal when the boundary throws, without saying the account would be stranded',
      'refuses a rotation when the boundary has never heard of the account',
      'refuses a threshold round when the boundary answers without the numbers in it',
    ],
  },
  /*
   * ── 11 TO 14: WHICH THRESHOLD, AND WHETHER A VAULT CAN BE MADE
   *              UNSPENDABLE ────────────────────────────────────────────────
   *
   * **THE SAME SUBJECT AS 01 TO 03 WITH THE QUESTION MADE SHARPER.** `R4`
   * moved the approval answer to the boundary; `R5` made the answer per-vault,
   * and the contract has enforced a per-vault threshold since V-33 while the
   * application could not express one.
   *
   * **WHAT MAKES THESE FOUR WORTH HAVING IS THAT THE WRONG ANSWER IS RIGHT
   * ALMOST EVERYWHERE.** `thresholdFor` returns the account's threshold for
   * every vault nobody gave one, so a version that ignores the vault entirely
   * is correct on every account that has never set an exception — which is
   * every account today — and wrong on exactly the account that set one, for
   * exactly the proposal the exception exists for. That is why the tests set
   * the two sources to DIFFERENT values and drive two vaults through one
   * account, and why 11 and 12 are two mutations rather than one: 11 breaks the
   * vault that HAS a threshold, 12 breaks the vault that does NOT, and a single
   * mutation would have proved one of them and looked like it proved two.
   *
   * **13 AND 14 ARE THE TWO HALVES OF THE FIRST TRAP** and are separate for the
   * same reason 08 and 09 are: separate lines with separate outcomes, one
   * refusing a threshold the CONTRACT also refuses and one refusing a state the
   * contract would accept.
   */
  {
    id: 11,
    binding: "A ROUND IS MEASURED AGAINST ITS OWN VAULT'S THRESHOLD",
    file: 'src/core/account.ts',
    says: "the reduction takes the ACCOUNT's threshold again, so a vault somebody deliberately "
      + "gave a lower bar is held to the account's — the capability C172 was raised about, "
      + 'unreachable from the application again, and invisible on every account that has never '
      + 'set an exception',
    from: '    threshold: thresholdFor(status, vault),',
    to: '    threshold: status.threshold,',
    kills: [
      "judges a vault that has its own threshold by that threshold, not the account's",
    ],
  },
  {
    id: 12,
    binding: 'AND ABSENCE MEANS INHERIT, NOT "WHATEVER IS IN THE MAP"',
    file: 'src/core/ledger.ts',
    says: 'the lookup stops naming the vault and takes the first exception in the map, so a '
      + "vault nobody gave a threshold is judged by SOMEBODY ELSE'S — the second trap, where a "
      + 'map holding a row for a vault it should not is not the same state as absence',
    from: '  const own = status.vaultThresholds.find(v => v.vault === vault);',
    to: '  const own = status.vaultThresholds[0];',
    kills: [
      "judges a vault with no threshold of its own by the account's, in the same account",
    ],
  },
  {
    id: 13,
    binding: 'ZERO IS REFUSED BY THIS APPLICATION, BEFORE ANYBODY SIGNS',
    file: 'src/core/account.ts',
    says: 'the propose-time refusal stops firing, so a threshold of zero is relayed, collects '
      + 'every signature, and is refused by the contract at the end — a refusal that arrives '
      + 'after the attention and the fee have been spent, on a number that would have '
      + 'authorised anything out of that vault',
    /*
     * **RETARGETED BY `S29`. `T-67`.** The three-line contiguous literal that
     * stood here — the `if`, the `throw new Error(` and the first line of the
     * message — stopped matching when a twenty-six-line comment was inserted
     * between the guard and the throw (`T-62`'s citation fix). The guard itself
     * never moved, so this mutation had been REFUSING as stale, certifying
     * nothing, rather than failing.
     *
     * **THE ANCHOR IS THE GUARD PLUS THE FIRST LINE OF THAT COMMENT, AND IT
     * HAS TO BE.** `if (!Number.isInteger(newThreshold) || newThreshold < 1) {`
     * appears TWICE in this file — `:1113` is the account's own threshold and
     * `:1272` is a vault's — so the bare line is an AMBIGUOUS TARGET and the
     * harness would refuse it for a second, different reason. Verified 31 Aug:
     * one occurrence, at `:1272`.
     */
    from: "    if (!Number.isInteger(newThreshold) || newThreshold < 1) {\n      /*\n       * THE LINE NUMBER IN THIS MESSAGE IS SHOWN TO A CUSTOMER",
    to: "    if (false) {\n      /*\n       * THE LINE NUMBER IN THIS MESSAGE IS SHOWN TO A CUSTOMER",
    kills: [
      'refuses zero, and no proposal exists afterwards',
    ],
  },
  {
    id: 14,
    binding: 'AND SO IS A THRESHOLD NOBODY COULD MEET — A REFUSAL THAT IS OURS',
    file: 'src/core/account.ts',
    says: 'the seat guard stops firing, so a vault can be given a threshold above the number of '
      + 'seated signers. The contract ACCEPTS that (:2103-2107) and the vault becomes '
      + 'unspendable until another governed round lowers it — the one state this round was told '
      + 'the setting surface must not be able to produce',
    from: '    if (newThreshold > onChain.signerCount) {',
    to: '    if (false) {',
    kills: [
      'refuses a threshold above the seats the LEDGER holds, and says the refusal is ours',
    ],
  },
  {
    id: 4,
    binding: 'THE ONE-WIRING-POINT DETECTOR ACTUALLY FINDS A CODE REFERENCE',
    file: 'src/wiring/one-wiring-point.test.ts',
    says: 'the allow-list loses `core/ledger.ts`, so the file that DEFINES the simulated '
      + 'implementations becomes an offender — the negative control R2 and R3 each ran by '
      + 'hand, in a throwaway replication outside the tree, and never again',
    from: "const ALLOWED = new Set([\n  'core/ledger.ts',\n  'wiring/selection.ts',\n]);",
    to: "const ALLOWED = new Set([\n  'wiring/selection.ts',\n]);",
    kills: [
      'no other file on the product path names a simulated implementation in code',
    ],
  },
  {
    id: 5,
    binding: 'AND THE DETECTOR IS NOT BLIND — THE PRESENCE ASSERTION IS LOAD-BEARING',
    file: 'src/wiring/one-wiring-point.test.ts',
    says: 'the block-comment pattern goes greedy, so everything between the first `/*` and '
      + 'the last `*/` of a file is blanked and the walk reads almost nothing — the exact '
      + 'shape of "no file reaches a simulated implementation" being true because the '
      + 'stripper ate the file',
    from: '    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, blank)',
    to: '    .replace(/\\/\\*[\\s\\S]*\\*\\//g, blank)',
    kills: [
      'the selector still reaches all three, or the search below proves nothing',
    ],
  },
  /*
   * ── 15 TO 18: A ROUND CANNOT HALF-HAPPEN, AND IS RECORDED UNDER THE
   *              TRANSACTION THAT HAPPENED ──────────────────────────────────
   *
   * **`R6`, `C169` AND `C170`.** `settle` and `execute` were two methods on the
   * `Ledger` boundary and the caller sequenced them, recording the FIRST one's
   * reference against the completed round. Two consequences: a window in which
   * one half landed and the other did not, and — silently — an identifier that
   * named the transaction which did not move the money, at the moment somebody
   * is trying to establish what happened. `R6` merged them into `settleRound`
   * BEFORE anybody implemented the transfer half, because the natural way to
   * implement it is to follow the interface, and the interface said to send
   * two.
   *
   * **WHY THESE FOUR AND NOT ONE.** They break in four directions and the code
   * that fixes them is four different lines. 15 is the identifier: one
   * transaction, one reference, and the defect it reproduces passes any test
   * that only checks a reference exists. 16 is the shape of the boundary: a
   * caller that could still sequence the two has not been stopped, so putting
   * `settle` back is the whole failure in one line. 17 and 18 are the two
   * directions of the ordering — 17 records the movement in front of the
   * transition's refusals, so a round refused for want of approvals leaves a
   * row describing money that never moved; 18 stops recording it at all, so a
   * balance falls with nothing to show for it. A single mutation would have
   * proved one of the four and looked like it proved four.
   *
   * **17 AND 18 KILL MORE THAN THE TEST WRITTEN FOR THEM, AND THAT IS
   * EXPECTED.** Both change how many rows exist, and the identifier test reads
   * the rows. What matters, and was watched by hand before these were
   * registered, is that each one's NAMED test dies on the assertion written for
   * it and not on an earlier one: 15 on the reference equality, 16 on the
   * absence of `settle`, 17 on the row left behind by a refused round, 18 on
   * the row that is missing after a completed one. That is `R4`'s lesson
   * applied ahead of time rather than after a run exposed it.
   *
   * **WHAT NONE OF THEM CAN REACH.** `SimulatedLedger` has no transactions.
   * These prove the boundary offers one operation, that the implementation
   * which exists performs both halves indivisibly, and that one identifier
   * covers them. Whether a Midnight transaction really carries a shielded
   * transfer and a contract call together is unproved by anything in this
   * repository and waits on `R1`; `MidnightLedger` refuses `settleRound`
   * outright for that reason.
   */
  /*
   * ── 19, 20, 22 TO 25. WHO MAY APPROVE AT ALL. ───────────────────────────
   *
   * **21 IS DELETED AND ITS REASON IS AT THE FOOT OF THIS GROUP.** The
   * paragraph about it below is kept because it is the argument that produced
   * the replacement, not because the row is still here.
   *
   * **THE BRIEF ASKED WHETHER THIS HARNESS SHOULD CARRY THE LEAF CHECK AND THE
   * ANSWER IS YES.** The leaf is what decides who may approve a payment on an
   * M-of-N account, and this file's subject is a place being the only place
   * entitled to give an answer. A stored leaf nobody checks is an authority
   * answer given by a RECORD instead of by a DEVICE, which is `R2`'s shape with
   * a different noun.
   *
   * **ALL THREE WERE RUN BY HAND BEFORE THEY WERE REGISTERED**, by `S33`, and
   * every gate this harness applies was simulated first: each `from` occurs
   * exactly once in its file, and every title in `kills` is in the suite's
   * baseline. `AUTHORITY-CHECK.command` is what proves them standing, and rule
   * 1 forbids a session running it, so it is named in the round's order.
   *
   * **19 AND 20 BREAK IN TWO DIRECTIONS AND ONE WOULD HAVE LOOKED LIKE TWO.**
   * 19 removes the comparison — the check answers `agrees` for every value,
   * which is `C325` reintroduced with a function in front of it. 20 keeps the
   * comparison and derives from the WRONG HALF of the device's material: the
   * blinding is hardcoded, so a device restored without its original blinding
   * — `C325`'s realistic case — is waved through while a substituted roster is
   * still caught. `S33`'s own first test set could not see 20, and its
   * test-coverage pass is what found that.
   *
   * **21 IS THE CALL SITE AND IT IS THE WEAK ONE, SAID HERE RATHER THAN LEFT TO
   * BE FOUND.** `src/web/App.tsx` has no test file, so what stands in is a
   * comment-stripped source pin, and a source pin cannot see semantics — the
   * same auditor defeated the first version three ways with the text intact.
   * This mutation is the one of the three it could not close: a local no-op
   * shadowing the import. **What closes it properly is a test file for the
   * screen**, `BACKLOG.md`.
   */
  {
    id: 19,
    binding: 'THE SEAT IS CHECKED AGAINST THE DEVICE, NOT TAKEN FROM THE RECORD',
    file: 'src/core/signer-leaf.ts',
    says: 'the comparison is deleted and every reading answers `agrees`, so a device that '
      + 'cannot reproduce its own leaf is seated in the product and every approval it makes '
      + 'is refused inside a proof — with the seat still counting towards the threshold',
    from: "    verdict: stored.toLowerCase() === derived.toLowerCase() ? 'agrees' : 'disagrees',",
    to: "    verdict: 'agrees',",
    kills: [
      'REFUSES a stored leaf this device does not compute',
      'REFUSES when the blinding on this device is not the one the leaf was built from',
      'refuses a roster substituted whole, because the key is DERIVED and not read',
    ],
  },
  {
    id: 20,
    binding: 'BOTH HALVES OF THE DEVICE\x27S MATERIAL DERIVE THE LEAF',
    file: 'src/core/signer-leaf.ts',
    says: 'the blinding is hardcoded rather than read from the device, so the check still '
      + 'catches a substituted roster and waves through the case it exists for — a device '
      + 'restored, or re-enrolled, without the blinding its leaf was built from',
    /*
     * **RE-POINTED BY `S34`, AND IT WENT STALE THE HONEST WAY.** The derivation
     * moved out of `ownLeafReading` into `storedSignerLeaf`, which is now the
     * ONE definition every writer and this check share. The binding is
     * unchanged; the line holding it is somewhere else.
     */
    from: '    material.blinding,',
    to: "    '22'.repeat(32),",
    kills: [
      'REFUSES when the blinding on this device is not the one the leaf was built from',
    ],
  },
  {
    id: 24,
    binding: 'THE FOUNDING WRITER CALLS THE ONE DEFINITION, NOT A SECOND SPELLING',
    file: 'src/core/account.ts',
    says: 'the creation path writes the leaf over the raw ed25519 public key again, which is '
      + 'C328 itself restored at the writer — every founding signer of every account made '
      + 'afterwards is a seat no device can prove, and it is silent until a proof on chain',
    /*
     * **REGISTERED BECAUSE IT SURVIVED.** `S34`'s test-coverage pass applied exactly
     * this and measured **261 passed, 0 failed**, both typechecks clean — the
     * file whose header calls itself the alarm for `C328` entered through the
     * shared helper and never through the writer. `core.test.ts` cannot see it
     * either: it uses `leafCommitment` as an opaque value on both sides of every
     * approval, so the writer and the checker move together, which is `C306`'s
     * shape arriving at the roster.
     */
    from: '        { signingSecret: sk.secret, blinding, scope }, this.commitments);',
    to: '        { signingSecret: sk.publicKey, blinding, scope }, this.commitments);',
    kills: [
      'SEATS WHAT `AccountService.create` WROTE, THROUGH THE WRITER AND NOT THE HELPER',
    ],
  },
  {
    id: 25,
    binding: 'NOTHING THAT IS NOT DURABLE REACHES A ROSTER',
    file: 'src/web/accept-seat.ts',
    says: 'the leaf is published before the material is sealed, so a version conflict on the '
      + 'seal seats a signer whose signing secret and blinding never survived the closure — '
      + 'C329, and the seat still counts towards the threshold it can never help reach',
    /*
     * This is the order `C329` is about, and until `S34` it lived in
     * `src/web/App.tsx`, which no test imports. Moving the sequence into its own
     * function is what makes this row possible at all.
     */
    from: '  await doors.seal(seat);',
    to: '  /* moved below */',
    kills: [
      'SEALS BEFORE IT PUBLISHES, and promotes only after',
      'PUBLISHES NOTHING when the seal refuses',
    ],
  },
  {
    id: 22,
    binding: 'THE PUBLIC HALF IS THE CONTRACT\x27S DERIVATION AND NOT SOMETHING ELSE',
    file: 'src/midnight/commitments.ts',
    says: 'the adapter hands back the secret itself instead of the circuit\x27s hash of it, '
      + 'so every seat the product writes is a leaf `requireSigner()` will never find — '
      + 'which is C328 exactly, and it is silent until a proof is attempted on chain',
    from: '    return toHex(pureCircuits.signerPublicKey(fromHex(signingSecret)));',
    /*
     * **THIS MUTATION COULD NOT BE SCORED AT ALL UNTIL `S56` RE-AIMED IT, AND
     * THE OLD `to:` IS WHY.** `T-295` `P1`.
     *
     * The line above is not only a call — it is a SCANNED call site.
     * `scripts/edge-list.ts:147` looks for that shape across `src`, `scripts`
     * and `contracts/test`, and `docs/design/edges.json` records it as
     * `src/midnight/commitments.ts:123`. A `to:` that DELETED the call removed
     * the edge, the render differed, `scripts/doc-freshness.ts:428` threw in a
     * `globalSetup`, and vitest emitted an empty 483-byte report. **It is the
     * only mutation in the repository whose own edit trips the documentation
     * gate — measured: of the 33 source files the sixteen harnesses mutate,
     * exactly one appears in `edges.json`.**
     *
     * **SO THE MUTATION NOW KEEPS THE CALL AND THROWS ITS ANSWER AWAY.**
     * `toHex(...)` is a non-empty string, so `&&` yields `signingSecret` and
     * the defect is unchanged: the adapter hands back the secret. The call site
     * stays on line 123, the edge stays identical, and the gate does not fire.
     * **MEASURED by `S56`, with the tree restored after: the suite RAN and four
     * tests went red, including both names below.**
     *
     * **AND THE `to:` IS ASSEMBLED FROM TWO PIECES ON PURPOSE.** Written whole,
     * this very line would be a SECOND scanned call site — in this file, at this
     * line — and would add an edge `edges.json` does not have, which is the same
     * refusal from the other direction. The `+` is what keeps the scanner from
     * matching. Do not tidy it into one string.
     */
    to: '    return toHex(pureCircuits.'
      + 'signerPublicKey(fromHex(signingSecret))) && signingSecret;',
    kills: [
      'SEATS THE LEAF THE PRODUCT WRITES AND THEN ACTS WITH IT, in circuit',
      'the adapter is the circuit, so nothing restates the hash in TypeScript',
    ],
  },
  {
    id: 23,
    binding: 'THE SCOPE IS PART OF THE LEAF AND TRAVELS WITH THE SEAT',
    file: 'src/core/signer-leaf.ts',
    says: 'the scope is forced to the default rather than read from the device, so the first '
      + 'seat written under a per-vault scope is one its own device cannot reproduce — the '
      + 'check inventing the lockout it exists to report. T-116',
    from: '    material.scope ?? commitments.allVaults(),',
    to: '    commitments.allVaults(),',
    /*
     * ONE TITLE, AND THE SECOND CANDIDATE WAS DROPPED BY SIMULATING IT RATHER
     * THAN BY READING IT. *a device carrying the WRONG scope is a mismatch*
     * SURVIVES this mutation — forcing the derivation to the default still
     * disagrees with a leaf stored under a per-vault one — so naming it would
     * have registered a row that reports `survived` for a binding it does not
     * test. `S34` ran all four rows by hand, checksummed, before registering.
     */
    kills: [
      'a leaf stored under a NON-DEFAULT scope is not reported as a mismatch',
    ],
  },
  /*
   * ── 21 IS DELETED, WITH ITS REASON. ─────────────────────────────────────
   *
   * It mutated `src/web/App.tsx` — a local no-op shadowing the imported
   * refusal — and its `kills` named the comment-stripped source pin, *is called
   * on the one screen where both copies exist*. **BOTH SIDES OF IT ARE GONE**:
   * `S34` deleted the pin, because a pin cannot see semantics and `S34` found
   * the fourth defeat the pin's own comment predicted — `loadDemo` built a
   * `Session` without ever entering `openAccount`, so a second door skipped the
   * refusal with the pin green and this mutation would have survived it.
   *
   * **WHAT REPLACED THE PIN IS A TYPE, AND THIS HARNESS CANNOT MUTATE A TYPE.**
   * `Session.seat` is a `SeatOnThisDevice`, branded with a symbol
   * `signer-leaf.ts` does not export, and `seatOnThisDevice` — which refuses a
   * mismatch — is its only constructor. A door into the product that skips the
   * check does not compile.
   *
   * **SO SAY WHAT IS ENFORCED AND WHAT IS NOT** (rule 27). Enforced: a NEW way
   * into the product that forgets the check is a build failure, caught by the
   * typecheck gate in `TEST.command` before a test runs. NOT enforced: a
   * deliberate `as any` beside the call. That residue is a `BACKLOG.md` row
   * with a destination, and what closes it is still a test file that renders
   * the screen — the same sentence 21 carried, minus the mutation that could
   * not hold it.
   *
   * 22 and 23 above are what this harness gained in exchange, and both are
   * killed by tests that run the real circuits or the real scope.
   */
  /*
   * ── 15 TO 18 ARE DELETED, WITH THEIR REASON. ─────────────────────────────
   *
   * **THE WHOLE `R6`/`C169`/`C170` GROUP, AND EVERY LINE OF THE CODE IT GUARDED
   * IS GONE.** They mutated `SimulatedLedger.settleRound` — the round's two
   * halves offered separately, the movement recorded before the guards ran, the
   * movement not recorded at all, and the published reference differing from the
   * kept one. `C292`/`S26` deleted `settleRound` and `RoundSettlement`
   * (`src/core/ledger.ts:451` is the comment standing where the type was), and
   * `S29` deleted `SimulatedLedger.txs`, which two of the four wrote to.
   *
   * **AND ALL FOUR `kills` NAMED TESTS IN A FILE THAT IS NOT ON DISK.** The
   * only copy of `src/core/settling-and-executing-are-one.test.ts` is under
   * `_to_delete/S26-C292/`. So each of these four could refuse for two separate
   * reasons at once and had been doing so since `S26`.
   *
   * **WHAT IS UNCOVERED, AND IT IS NOT NOTHING.** `R6`'s rule — that neither
   * half of a settlement is offered on its own, and that a refused round leaves
   * no record behind — has no mutation and no test in this repository any more,
   * because it has no code either. **The rule comes back the day a vault pays a
   * run**, which is the round that has to write it, its tests and its mutations
   * together. Named rather than left as four permanently-stale rows.
   */
  /*
   * ── 26 AND 27 ARE `S52`'s, AND THEY GUARD THE TWO `P1`s THAT ROUND CLOSED. ─
   *
   * **BOTH ARE HERE BECAUSE OF WHAT KILLED THE DEFECTS THEY REVERSE: NOTHING.**
   * `C376` sat in `src/core/ledger.ts` and was invisible to every test in the
   * repository — `SC10`'s test-coverage pass measured that replacing its ternary
   * with the correct line left the whole suite green. `C377` was the last
   * statement of `approve` being the only durable write, and no test asked what
   * happened if the call above it threw. **A defect that no test can see is a
   * defect a refactor restores**, which is exactly what a mutation harness is
   * for, and neither of these had an entry until now.
   */
  {
    id: 26,
    binding: 'A GOVERNANCE ROUND IS MEASURED AGAINST THE ACCOUNT\'S THRESHOLD, NEVER A VAULT\'S',
    file: 'src/core/ledger.ts',
    says: 'the simulated ledger goes back to looking a vault\'s threshold up for GOVERNANCE, '
      + 'which is the payment path\'s rule applied to the wrong one of the contract\'s two '
      + 'entry points — so a round naming a vault whose bar was lowered is judged at that '
      + 'lower bar, and setThreshold and removeSigner execute below the account\'s own '
      + 'threshold, which is the recovery path',
    /*
     * **THE REPLACEMENT IS THE CODE THAT WAS THERE UNTIL 4 Sep**, character for
     * character, so this entry scores the exact regression rather than an
     * invented one.
     */
    from: '    const bar = a.threshold;',
    to: '    const bar = a.vaultThresholds.has(p.vault) ? a.vaultThresholds.get(p.vault) : a.threshold;',
    /* The first three were MEASURED by `S52` against this exact replacement. The
     * third is the one that separates *does not look a vault up* from *takes
     * the stricter of the two* — `S52`'s test-coverage pass showed a `Math.max` bar
     * passed the first two, so without it this entry scored a weaker property
     * than its `binding` line claims.
     *
     * **THE LIST UNDER-CLAIMED BY TWO AND `S58` MEASURED THE TRUE SET.**
     * Applying this entry's exact `to:` string to the working tree and
     * running `src/core/a-vault-s-own-threshold.test.ts` turns **five** cases
     * red, not three: `C368`'s sentinel case was already among them when `S56`
     * seated the sentinel, and `T-290`'s `removeSigner` case is `S58`'s.
     *
     * **AN UNDER-CLAIMING `kills:` LIST IS NOT HARMLESS, WHICH IS WHY IT IS
     * FIXED RATHER THAN NOTED.** The list is how a reader knows what this
     * mutation actually scores; a short one makes the property look thinner
     * than it is and invites a later round to "add the missing coverage" that
     * is already there. **And nothing refuses a wrong list in either
     * direction — a name that catches nothing, or a catcher left out — which
     * is `T-337`'s open half and is NOT closed by this correction.** */
    kills: [
      'refuses a setThreshold round that has only met the vault it names',
      'refuses to lower a vault\'s bar on the authority of that same lowered bar',
      'judges a round naming a vault whose bar is HIGHER by the account\'s lower one',
      'judges a GOVERNANCE round by the account, with the SENTINEL seated in the map — `C368`',
      'refuses a removeSigner round that has only met the vault it names — `T-290`, `S58`',
    ],
  },
  {
    id: 27,
    binding: 'A BURNT APPROVAL IS DURABLE BEFORE ANYTHING THAT CAN THROW RUNS',
    file: 'src/core/account.ts',
    says: 'the durable write moves back behind the second network call, so a throw between '
      + 'the chain burning the nullifier and the record being written loses the approval '
      + 'for ever — the retry finds no local record, calls the chain again, and the chain '
      + 'refuses on the nullifier it already holds',
    /*
     * **DELETING THE FIRST WRITE IS THE WHOLE OF `C377`**, because the second
     * write still stands below it: the mutation does not remove persistence,
     * it restores the WINDOW. That is the honest shape of the regression a
     * later refactor would produce — somebody tidying two `putProposal` calls
     * into one.
     */
    from: '    this.putProposal(proposal, viewingKey);\n\n    /*\n     * **AND THE STANDING, WHICH IS THE HALF THAT NEEDS THE CHAIN.**',
    to: '    /*\n     * **AND THE STANDING, WHICH IS THE HALF THAT NEEDS THE CHAIN.**',
    /* MEASURED by `S52`, and the list is the four that actually died — the
     * third name here was RENAMED after `S52`'s test-coverage pass showed the old
     * one was not the negative control it claimed to be, and a kill list
     * naming a test that no longer exists is a STALE EXPECTATION that aborts
     * the whole run before mutation [1]. */
    kills: [
      'keeps the approval when the status read throws, so the retry is not refused for ever',
      'recovers the standing on the retry, and still refuses the second approval',
      'does not swallow the throw when the node is still down on the retry',
      'does not reconcile for a signer who has not approved, and still records them',
    ],
  },
  {
    id: 28,
    binding: 'THE RECONCILE IS WHAT MAKES A BURNT APPROVAL\'S STANDING RECOVERABLE',
    file: 'src/core/account.ts',
    says: 'the recovery half of C377 is removed, so a round whose last approver hit a failed '
      + 'status read stays `open` for ever with the chain holding a satisfied round — the '
      + 'approval survives, which is 27\'s half, and nothing can ever record the standing',
    /*
     * **27 AND 28 ARE THE TWO HALVES AND EACH SURVIVES THE OTHER'S TEST**,
     * which is why they are two entries. Measured: deleting the first write
     * kills four cases, deleting the reconcile kills two, and only one case is
     * killed by both. An entry covering both at once would have scored the
     * pair and told nobody which half had gone.
     */
    /*
     * **RE-ANCHORED BY `S55` IN THE SAME TURN, RULE 18's SECOND CLAUSE AND
     * `T-184`'s LESSON.** `C378` needed a line inside `approve` and `C366`
     * forbids moving one in this file, so the gate's two-line condition was
     * merged onto one. **The entry's `from:` matched ZERO times afterwards, and
     * a single stale entry aborts the whole run before mutation [1] — the
     * alarm, fired by the round that caused it, exactly as `R5` fired it once
     * before.** The BINDING under test is unchanged and so are its `kills`.
     */
    /*
     * **RE-ANCHORED AGAIN BY `S58`, IN THE TURN THAT MOVED THE LINE — RULE 18,
     * AND THE ALARM FIRED THE SAME WAY IT DID FOR `S55`.** `T-286` wrapped the
     * reconcile call in a `try`/`catch` that lets exactly one non-transient
     * failure past (`ProposerRoleGone`), so this entry's three-line `from:`
     * matched ZERO times and a single stale entry aborts the whole run before
     * mutation [1]. **Found by re-parsing the corpus over the real tree before
     * finishing, which is what the brief ordered and what `S55` did.**
     *
     * **AIMED AT THE CALL RATHER THAN THE BLOCK, WHICH IS THE MORE DURABLE
     * ANCHOR.** The gate's condition and the error handling around it are both
     * things a later round may legitimately reshape; what must never quietly
     * disappear is the reconcile CALL itself, and deleting it removes the
     * recovery while leaving everything that looks like it. The eight-space
     * indent is what makes this unique — the ordinary path's call to the same
     * method sits at four. Verified: exactly one match. The BINDING under test
     * is unchanged and so are its `kills`.
     */
    from: '        await this.recordStanding(proposal, account, viewingKey);\n',
    to: '',
    kills: [
      'recovers the standing on the retry, and still refuses the second approval',
      'does not swallow the throw when the node is still down on the retry',
    ],
  },
  {
    id: 29,
    binding: 'THE RESERVED NAME IS REFUSED ON BOTH PATHS AND NOT ONLY WHERE A ROUND IS RAISED',
    file: 'src/core/account.ts',
    says: 'the apply path stops refusing `noVault()`, which is the state the product was in '
      + 'until S56 — the raise path refused the sentinel and the boundary it can be reached '
      + 'without did not, while the comment above them said the zero refusal was repeated '
      + 'there BECAUSE the two are reachable independently',
    /*
     * **`T-265` `P1`. THE MUTATION IS THE DELETION OF `S56`'s OWN FIX**, which
     * is the point: a fix with a test and no mutation is a fix whose test
     * nothing measures. `S56`'s test-coverage pass raised it — mutations 13 and 14
     * already prove the two neighbouring refusals in that same file load-bearing
     * and this one had nothing.
     */
    from: "    if (vault === this.commitments.noVault()) {\n      throw new Error(\n        'that is the reserved name for a proposal that concerns no vault, not a vault. ' +\n          \"The account's own threshold is changed with proposeThresholdChange.\",\n      );\n    }\n",
    to: '',
    kills: ['refuses the RESERVED NAME on the apply path too, which is the half nothing guarded'],
  },
  {
    id: 30,
    binding: 'THE ONE-WIRING-POINT SEARCH CAN READ THE TREE IT WALKS',
    file: 'src/wiring/one-wiring-point.test.ts',
    says: 'the quote pass is allowed to cross a newline again, so a prose apostrophe opens a '
      + 'string that runs to the next one anywhere in the file — which blanked 395 lines of '
      + 'the tree the selector search walks, 293 of them in the one file C175 is half about, '
      + 'while the search stayed green',
    /*
     * **A THIRD MUTATION AIMED AT A CHECKER, FOR THE SAME REASON AS 04 AND 05
     * AND FROM A LIVE DEFECT RATHER THAN AN IMAGINED ONE.** `T-280` `P1`,
     * `S46`'s test-coverage pass found it with planted text and `S56` fixed it.
     *
     * 05 makes the BLOCK-COMMENT pass over-blank and the presence assertions
     * notice. This makes the QUOTE pass over-blank, which nothing noticed for as
     * long as the file existed — the two controls it had both read
     * `wiring/selection.ts`, the one file that cannot trip it. The control this
     * kills is the one written the day it was found.
     */
    from: "    .replace(/(?<![A-Za-z0-9_$)\\]])(['\"])(?:\\\\.|(?!\\1)[^\\n\\\\])*\\1/g, blank)",
    to: "    .replace(/(?<![A-Za-z0-9_$)\\]])(['\"])(?:\\\\.|(?!\\1)[\\s\\S])*\\1/g, blank)",
    kills: ['a prose apostrophe does not blind the search — T-280, on a fixture and on the tree'],
  },
  {
    id: 31,
    binding: 'A PROSE APOSTROPHE IS NOT A STRING DELIMITER',
    file: 'src/wiring/one-wiring-point.test.ts',
    says: 'the quote pass accepts an apostrophe that follows a letter as an OPENER again, so '
      + 'code sitting between two prose apostrophes on one line is blanked and the selector '
      + 'search cannot see it',
    /*
     * **30 AND 31 ARE THE TWO HALVES OF ONE GUARD AND EACH SURVIVES THE
     * OTHER'S CONTROL — MEASURED, WHICH IS WHY THERE ARE TWO.** With only the
     * multi-line plants in that file, removing EITHER the newline bound (30) or
     * this lookbehind left every case green; a control that no single edit can
     * break is measuring nothing. `S56` added one plant per defence and these
     * two entries are what keep each plant honest.
     */
    from: "    .replace(/(?<![A-Za-z0-9_$)\\]])(['\"])(?:\\\\.|(?!\\1)[^\\n\\\\])*\\1/g, blank)",
    to: "    .replace(/(['\"])(?:\\\\.|(?!\\1)[^\\n\\\\])*\\1/g, blank)",
    kills: ['a prose apostrophe does not blind the search — T-280, on a fixture and on the tree'],
  },
  /*
   * ── `S55`'s FOUR, AND EVERY KILL COUNT BELOW WAS MEASURED BY THAT ROUND ──
   *
   * Rule 42a(c): each mutation was applied by hand, ONE named suite was run,
   * the file was restored from a copy taken in the same command and `diff -q`
   * proved the restore. **The counts are values. The VERDICT is this door's and
   * rule 9 forbids a session it.**
   */
  {
    id: 32,
    binding: 'THE DURABLE RECORD IS WRITTEN BEFORE THE IRREVERSIBLE CHAIN CALL',
    file: 'src/core/account.ts',
    says: 'the record goes back to being written AFTER the chain call, which is C378 exactly — '
      + 'a failed write then leaves a proposal paid for, live on chain, and with no durable '
      + 'record of any kind, so the product cannot list it, approve it or cancel it',
    from: '    this.putProposal(proposal, viewingKey);\n    const tx = await call();',
    to: '    const tx = await call();',
    kills: [
      'keeps the proposal when the chain call throws, and says the chain has not confirmed it',
      'and that record can be cancelled, which is what "the product cannot cancel it" was',
      'CONFIRMS a round the chain did accept when the answer was lost, on the first approval',
      'REFUSES to cancel when the ledger did not answer, rather than clearing consent on a guess',
      'a round the chain never held does not displace the APPROVED round for the same change',
    ],
  },
  {
    id: 33,
    binding: '"THE LEDGER DID NOT ANSWER" IS NOT "THE ROUND IS NOT ON CHAIN"',
    file: 'src/core/account.ts',
    says: 'a null status is read as absence, so cancel closes the record locally and clears its '
      + 'approvals while the chain goes on holding the round open and approved — R4\'s '
      + 'distinction, and the P1 this round\'s money-safety-auditor caught before it shipped',
    from: "    if (status === null) return 'unknown';",
    to: "    if (status === null) return 'absent';",
    kills: [
      'REFUSES to cancel when the ledger did not answer, rather than clearing consent on a guess',
    ],
  },
  {
    id: 34,
    binding: 'A ROUND THE CHAIN NEVER HELD DOES NOT DISPLACE THE APPROVED ROUND',
    file: 'src/core/account.ts',
    says: 'approvedFor goes back to newest-first alone. A governance digest is a pure function '
      + 'of the change, so an unconfirmed re-raise collides with the genuinely approved round '
      + 'and wins on createdAt, pointing ALL FOUR of its callers — grantAccess, setThreshold, '
      + 'setVaultThreshold and removeSigner — at an id no chain holds. This sentence named '
      + 'removeSigner alone until S58 (T-332), which left out the two callers a screen can '
      + 'actually reach today',
    from: "      (a.status === 'approved' ? 0 : 1) - (b.status === 'approved' ? 0 : 1)\n"
      + '      || (a.raisedAt ? 0 : 1) - (b.raisedAt ? 0 : 1)\n'
      + '      || b.createdAt.localeCompare(a.createdAt))[0];',
    to: '      b.createdAt.localeCompare(a.createdAt))[0];',
    /* **MEASURED BY `S58` AGAINST THIS ENTRY'S EXACT `to:`: TWO, NOT ONE.**
     * The second case drives `grantAccess`, the caller with two
     * product routes and the one no case reached until `S58`. */
    kills: [
      'a round the chain never held does not displace the APPROVED round for the same change',
      'and `grantAccess` reaches the APPROVED round too, not the phantom — `T-332`, `S58`',
    ],
  },
  {
    id: 35,
    binding: 'THE LEDGER THE PRODUCT RUNS ON REFUSES A GOVERNANCE ROUND THAT NAMES A VAULT',
    file: 'src/core/ledger.ts',
    says: 'T-237 is undone and this class stops mirroring compact:2319, so a governance round '
      + 'may name a vault here and mint a bit-identical id to a run\'s with no runWindow row — '
      + 'and on SIMULATED wiring this class is the product\'s only enforcement',
    from: '    if (vault !== this.commitments.noVault()) {',
    to: '    if (false) {',
    kills: [
      'REFUSES a governance round that names a vault at all — `T-237`, `C367`, `S55`',
    ],
  },
  {
    id: 36,
    binding: 'A ROUND IS JUDGED AGAINST THE ROLE IT WAS RAISED UNDER, NOT AGAINST A SEAT THAT MAY BE GONE',
    file: 'src/core/account.ts',
    says: 'the role stored on the proposal when the round was raised is ignored and the live '
      + 'roster decides again — so a round whose proposer has since been removed has no role '
      + 'anywhere, and C377 comes back: the round cannot be approved by anybody, ever, with '
      + 'its money still in it',
    /*
     * **THIS ENTRY EXISTS BECAUSE THE FIX HAD TWO TESTS AND NO MUTATION.**
     * `T-286`, found by the controller asking *has this actually been fixed*
     * about a fix already committed, and confirmed by `S67` at source: no entry
     * in this corpus named `proposerRole` or `ProposerRoleGone`, and entries 27
     * and 28 — the nearest, and the ones `S58` re-anchored — guard the burnt
     * approval's standing, which is a different binding.
     *
     * The `to:` is the pre-`S58` BEHAVIOUR — the stored role dropped, the lookup
     * left to answer alone. **It is not claimed to be that line's exact bytes:
     * establishing that needs history, and rule 4 forbids this session `git`.**
     * **MEASURED: it takes the two named cases red and nothing else in the
     * eight suites.**
     */
    from: '    const proposerRole = proposal.proposerRole\n'
      + '      ?? account.signers.find(s => s.id === proposal.proposedBy)?.role;',
    to: '    const proposerRole = account.signers.find(s => s.id === proposal.proposedBy)?.role;',
    kills: [
      'A ROUND SURVIVES ITS PROPOSER BEING REMOVED, AND THE NEXT APPROVAL DOES NOT THROW — `C377`, `T-286`, `S58`',
      'AND THE SAME THROUGH A GOVERNANCE DOOR, WHICH IS THE HALF THE FIRST DRAFT MISSED — `T-286`, `S58`',
    ],
  },
  {
    id: 37,
    binding: '"THE CHAIN COULD NOT BE ASKED" IS NOT "THE CHAIN DISAGREES"',
    file: 'src/midnight/ledger.ts',
    says: 'the third state collapses into the second, so an unreachable indexer, an address '
      + 'the provider holds nothing for, and a state this cannot parse all report that the '
      + 'contract carries the WRONG maintenance authority — and the round downstream rebuilds '
      + 'and re-signs a real maintenance update against a chain it never read',
    /*
     * **`T-358`'s OWN *done when*, TAKEN LITERALLY.** That row says: at least one
     * mutation against the three-state comparator, and the obvious one flips
     * `unknown` to `disagree` for a non-`read`. This is that one.
     *
     * `S55` shipped a `P1` collapsing exactly this three into two, in a
     * different file, six days ago. The comparator this mutates is the one a
     * maintenance update is judged by.
     */
    from: "  if (read.state !== 'read') {\n"
      + '    return {\n'
      + "      verdict: 'unknown', address: read.address, intended,",
    to: "  if (read.state !== 'read') {\n"
      + '    return {\n'
      + "      verdict: 'disagree', address: read.address, intended,",
    kills: [
      'says UNKNOWN and never DISAGREE when the chain could not be asked',
      'says UNKNOWN and not DISAGREE when the provider holds no state for the address',
      'REFUSES when the chain could not be asked, and never calls that a disagreement',
    ],
  },
  {
    id: 38,
    binding: 'A THRESHOLD BELOW ONE IS REFUSED WHERE AN AUTHORITY IS BUILT, NOT ONLY WHERE IT IS READ',
    file: 'src/midnight/ledger.ts',
    says: 'the world-writable value can be BUILT again — a threshold of zero passes into a '
      + 'ReplaceAuthority payload, and MEASURED on ledger 9 the chain then accepts a '
      + 'maintenance update carrying no signatures at all from anybody in the world',
    /*
     * `S61` closed the READ side and its row says in its own words that
     * nothing stopped the value being CHOSEN or INSTALLED. This guard is the
     * install side, and this entry is what keeps it there.
     */
    from: '  if (!Number.isInteger(threshold) || threshold < 1) {\n'
      + '    out.push({\n'
      + "      code: 'threshold-below-one',",
    to: '  if (false) {\n'
      + '    out.push({\n'
      + "      code: 'threshold-below-one',",
    kills: [
      'refuses a threshold of zero and calls it WORLD-WRITABLE, never unmaintainable',
      'refuses an unbuildable intended value without asking the chain for a verdict on it',
      'requireBuildableAuthority throws with EVERY reason, not the first one',
    ],
  },
  {
    id: 39,
    binding: 'THE VERIFIER KEYS ARE COMPARED BY THEIR BYTES, NOT BY THEIR NAMES',
    file: 'src/midnight/ledger.ts',
    says: 'every entry point whose name matches is called a match, so `C353`\'s drain — a '
      + 'verifier key swapped under an unchanged name, which is the act that actually moves '
      + 'the money — reports AGREE from the one instrument built to see it',
    /*
     * `docs/scope-the-upgrade-path.md:216-231`'s SILENTLY WEAKEN is 32
     * bytes on chain WITH THE OPERATIONS MAP LISTING THE SAME NAMES, which is
     * exactly the state this mutation produces and calls clean.
     */
    from: '    const same = op.verifierKey.length === want.length &&\n'
      + '      op.verifierKey.every((b, i) => b === want[i]);',
    to: '    const same = true;',
    kills: [
      'DISAGREES and names the entry point when the key on chain is not the one this build produces — `C353` seen',
    ],
  },
];

const only = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7);
const wanted = only ? new Set(only.split(',').map(Number)) : null;
const reportAt = (process.argv.find(a => a.startsWith('--report=')) ?? '').slice(9)
  || join(ROOT, 'logs', 'REPORT-MUTATE-AUTHORITY.txt');

/**
 * The last twenty lines of whatever the child said, for a report a person
 * reads. Empty in, empty out — a missing reason is printed as a missing
 * reason and never as a blank space that reads like nothing happened.
 */
const tail = (text, n = 20) => {
  const ls = String(text ?? '').split('\n').map(l => l.trimEnd()).filter(l => l !== '');
  return ls.length ? ls.slice(-n) : ['(the child printed nothing)'];
};

/**
 * Runs the suites and returns what the run actually COLLECTED — not merely what
 * it PARSED.
 *
 * **`ran` USED TO MEAN *THE JSON PARSED*, AND THAT IS THE DEFECT THIS ROUND WAS
 * CALLED TO FIX.** A vitest run that collects
 * NOTHING — a `globalSetup` that threw, a config error, a crashed worker —
 * still writes a well-formed 483-byte report: `numTotalTestSuites: 0`,
 * `numTotalTests: 0`, `testResults: []`, `success: false`, exit 1. **That
 * parses.** `failures` was then `0`, and the loop below printed *SURVIVED. The
 * code was broken and every test still passed* — the loudest sentence this
 * harness owns, about a run in which not one of the 75 assertions executed.
 * **That is `R4`/`C121`'s own error — "we could not read the chain" is not "not
 * enough approvals" — committed by the instrument that exists to police it.**
 *
 * **AND THE OTHER HALF NEVER REACHED `ran` AT ALL.** `flatMap(r =>
 * r.assertionResults ?? [])` swallows a suite entry that collected nothing —
 * a broken import, a syntax error, a module-scope throw. Such a report names
 * its files, parses, and yields an EMPTY assertion list, so the old code went
 * straight past the `!ran` branch to SURVIVED without even printing *the suite
 * did not run*. `emptyFiles` is that case named.
 *
 * So: `ran` means ASSERTIONS WERE COLLECTED; `collected` is the number a caller
 * compares against the baseline's; `byFile` keeps each assertion's SUITE FILE,
 * which the old return threw away at the one point the harness needed it; and
 * **`stderr` IS KEPT.** Under mutation 22 the only record of the cause was
 * vitest's refusal naming `DOCS.command`, and this function discarded it —
 * which is why that cost a round rather than a glance.
 */
function runSuite(tag) {
  const file = join(OUT, `${tag}.json`);
  try { rmSync(file); } catch { /* first run */ }
  let said = '';
  try {
    execFileSync('./node_modules/.bin/vitest',
      ['run', ...SUITES, '--reporter=json', `--outputFile=${file}`],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    /*
     * A failing suite exits non-zero, which is still the ordinary case here, so
     * this is not an error path. What changed is that the child's own words are
     * KEPT rather than dropped on the floor: on a suite that refused to START,
     * this is the only place the reason exists at all.
     */
    said = [e?.stderr, e?.stdout].map(b => (b ? String(b) : '')).join('\n');
  }
  let json;
  try { json = JSON.parse(readFileSync(file, 'utf8')); }
  catch {
    return {
      ran: false, collected: 0, emptyFiles: [], byFile: [], titles: [],
      failed: [], passed: 0, failures: 0, said,
      why: 'vitest wrote no report this run could parse',
    };
  }
  const suites = json.testResults ?? [];
  const byFile = suites.flatMap(r => (r.assertionResults ?? []).map(a => ({
    file: r.name ?? '(unnamed suite)', title: a.title, status: a.status,
  })));
  const emptyFiles = suites
    .filter(r => (r.assertionResults ?? []).length === 0)
    .map(r => r.name ?? '(unnamed suite)');
  return {
    ran: byFile.length > 0,
    why: byFile.length > 0 ? ''
      : `vitest wrote a report naming ${suites.length} suite file(s) and NOT ONE assertion`,
    collected: byFile.length,
    emptyFiles,
    byFile,
    said,
    /*
     * **A SKIPPED ASSERTION IS NOT ONE THAT RAN, AND `titles` IS WHAT CHECK 4
     * ASKS.** `S56`'s test-coverage pass measured vitest 4.1.10: when a `beforeAll`
     * throws, the file's assertions come back with `status: 'skipped'` and the
     * run reports ZERO failures — so a named guard that never executed would
     * have been present in `titles`, passed check 4, and scored SURVIVED. That
     * is this door's own defect surviving through a route the four checks did
     * not cover. Nothing in either corpus reaches it today; nothing kept it
     * that way, so it is closed here rather than filed.
     */
    titles: byFile.filter(a => a.status !== 'skipped').map(a => a.title),
    failed: byFile.filter(a => a.status === 'failed').map(a => a.title),
    passed: byFile.filter(a => a.status === 'passed').length,
    failures: byFile.filter(a => a.status === 'failed').length,
  };
}

/*
 * **A KILLED RUN PUTS THE FILE BACK, AND IT DOES NOT RELY ON A SIGNAL.**
 * Found the hard way, PI2b, twice; the reasoning is written out in full in
 * `scripts/mutate-refusals.mjs` and this is the same mechanism, not a variant.
 *
 * The short of it: `runSuite` uses `execFileSync`, which blocks the event loop,
 * so a `SIGTERM` arriving mid-suite cannot be serviced until the call it would
 * have interrupted has finished, and a `SIGKILL` never reaches JavaScript at
 * all. This runs under a 45-second call cap, so being killed part way through
 * is the ORDINARY case. The record of what is in flight therefore lives ON
 * DISK: the NEXT run reads it, puts the file back, and says so before doing
 * anything else.
 */
const JOURNAL = join(OUT, 'in-flight.json');

/**
 * The shape THIS door writes. A record without it was written before `S67` and
 * is refused rather than honoured — see `recoverFromLastRun`.
 */
export const JOURNAL_VERSION = 2;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
/** The real path when it exists, the spelt one when it does not — so a missing
 *  file is refused by the read below rather than by an exception here. */
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };

/*
 * **THE RECORD NAMES A PATH RELATIVE TO THE REPOSITORY ROOT, AND `S67` EXISTS
 * BECAUSE IT DID NOT.**
 *
 * The record `S58`'s killed run left behind held
 * `/sessions/rcw-018b58fnqybaxt3mkq6c8xu7/mnt/confidential-accounts-v5/src/core/account.ts`
 * — an absolute path into a container that no longer exists. **The only reason
 * the next run did not overwrite a finished round's `src/core/account.ts` with
 * a snapshot two hours older than it is that the write failed `ENOENT` and took
 * the door down before it reached anything else. A bug saved the tree from a
 * worse bug**, and on any machine where that path resolved the revert would
 * have been silent and would have printed a success sentence while doing it.
 * The evidence copy is kept at
 * `logs/mutate-authority/in-flight-STALE-2026-09-05-EVIDENCE.json`.
 *
 * A path is relative here so the process that writes the record and the process
 * that reads it agree about what it names, whatever either one's `cwd` was.
 */
export const beginMutation = (file, before, after, { journal = JOURNAL } = {}) => {
  /*
   * **`journal` IS INJECTABLE FOR THE SAME REASON `recoverFromLastRun`'s IS,
   * AND `S67` SHIPPED IT WITHOUT AND WAS CAUGHT BY ITS OWN AUDITOR.** Without
   * it a test pinning this function has to write the door's LIVE record — and
   * a test naming `src/core/account.ts` with a 59-byte `before`, killed
   * mid-run, jams the next door run with a refusal whose text invites a person
   * to restore 59 bytes over a 173,000-byte file. Rule 40's second clause,
   * created by a pin on the very mechanism rule 40 exists for.
   */
  mkdirSync(dirname(journal), { recursive: true });
  writeFileSync(journal, JSON.stringify({
    v: JOURNAL_VERSION,
    file,
    before,
    /*
     * **THE HASH IS OF THE MUTATED TEXT, NOT OF `before`, AND THAT IS THE WHOLE
     * POINT.** A hash of `before` answers *is the file already back?*, which is
     * not the question. The question recovery has to answer is *is this file
     * still the one I broke?*, and only the mutated text answers it.
     *
     * `expect` is what the file must read if this record is telling the truth.
     * `restored` is what it reads if the mutation never landed or has already
     * been put back — **and that branch is not an optimisation, it is
     * correctness: this record is written BEFORE the mutation is, so a run
     * killed between the two lines leaves a CLEAN tree with a live record, and
     * without `restored` the honest case would be reported as tampering.**
     *
     * Anything that is neither means somebody has worked in this file since the
     * run was killed. A journal that cannot tell *I broke this* from *somebody
     * has been working here since* is not a safety net; it is a loaded gun with
     * a friendly label.
     */
    expect: sha256(after),
    restored: sha256(before),
  }));
};

/*
 * **CLEARED, NOT DELETED.** `rm` is refused on the folder this runs against, so
 * an `rmSync` here fails, is swallowed by its own catch, and leaves the journal
 * behind after a successful run — which makes the next run announce a recovery
 * that did not happen. Writing an empty record needs no delete permission.
 */
export const endMutation = (path, before) => {
  writeFileSync(path, before);
  writeFileSync(JOURNAL, '{}');
};

/*
 * **RECOVERY REFUSES RATHER THAN WRITES WHEN WHAT IS ON DISK IS NOT WHAT THE
 * RECORD EXPECTS TO FIND THERE.** The version this replaced compared
 * NOTHING — not a hash, not an mtime, not a length — and did
 * `writeFileSync(held.path, held.before)` unconditionally, first thing, before
 * the baseline suite and before any mutation.
 *
 * There are three outcomes and the record alone tells them apart:
 *
 *   · the file hashes to `expect` — the mutation is still in the tree. This is
 *     the case the record exists for and the file is put back.
 *   · the file hashes to `restored` — the run was killed between writing the
 *     record and writing the mutation, or the restore already happened. The
 *     tree is clean: nothing to put back and nothing to announce.
 *   · anything else — **REFUSE.** Somebody has worked in that file since, and
 *     the stored copy would delete their work.
 *
 * **IT RETURNS ITS VERDICT RATHER THAN EXITING.** The decision to stop belongs
 * to the door, and a verdict can be tested without running one — which is the
 * other half of `T-348`, since the round that found this defect found it by
 * `import`ing this file and thereby RUNNING it.
 */
export function recoverFromLastRun(say, { root = ROOT, journal = JOURNAL } = {}) {
  let held;
  try { held = JSON.parse(readFileSync(journal, 'utf8')); } catch { return { state: 'nothing' }; }
  if (!held || typeof held !== 'object' || Object.keys(held).length === 0) {
    return { state: 'nothing' };
  }

  /*
   * **A RECORD FROM BEFORE THIS FIX CARRIES `path` AND NO HASH, AND IT IS
   * REFUSED RATHER THAN HONOURED.** It is exactly the artefact that nearly cost
   * a round its work: an absolute path, a whole-file snapshot, and nothing to
   * check either against. There is no version of trusting it that is safe.
   */
  if (held.v !== JOURNAL_VERSION || typeof held.file !== 'string'
      || typeof held.before !== 'string' || typeof held.expect !== 'string'
      || typeof held.restored !== 'string') {
    return {
      state: 'refused',
      file: typeof held.file === 'string' ? held.file : (held.path ?? '(unnamed)'),
      why: 'the in-flight record is not in this door\'s format. It carries no hash, so what is '
        + 'on disk cannot be told apart from a later round\'s work, and a record written by an '
        + 'older door may name a path on a machine that is not this one',
    };
  }

  /*
   * **A RECORD THAT NAMES ANYTHING OUTSIDE THE REPOSITORY IS REFUSED BEFORE IT
   * IS OPENED — AND THAT MEANS THE REAL PATH, NOT THE SPELT ONE.** `resolve`
   * does not follow links, so the first version of this check passed a
   * `src/link.ts` pointing anywhere on the machine and then WROTE THROUGH IT.
   * Measured by `S67`'s money-safety pass against `S67`. The check exists
   * for records this door did not write, which is exactly where a link would
   * come from.
   */
  const at = realOrSelf(resolve(root, held.file));
  const base = realOrSelf(resolve(root));
  if (isAbsolute(held.file) || (at !== base && !at.startsWith(base + sep))) {
    return {
      state: 'refused',
      file: held.file,
      why: `the in-flight record names ${held.file}, which is not a path inside this repository`,
    };
  }

  let live;
  try { live = readFileSync(at, 'utf8'); } catch {
    return {
      state: 'refused',
      file: held.file,
      why: `the in-flight record names ${held.file}, and there is no such file to put back`,
    };
  }

  const now = sha256(live);
  if (now === held.restored) {
    writeFileSync(journal, '{}');
    return { state: 'nothing' };
  }
  if (now !== held.expect) {
    return {
      state: 'refused',
      file: held.file,
      why: `${held.file} is neither the text this door mutated nor the text it would put back. `
        + 'Somebody has worked in that file since the run that wrote this record was killed, and '
        + 'writing the stored copy over it would delete their work',
    };
  }

  writeFileSync(at, held.before);
  writeFileSync(journal, '{}');
  say('  A PREVIOUS RUN WAS KILLED WITH A MUTATION STILL IN THE TREE.');
  say(`  ${held.file} has been put back before anything else was done.`);
  say('');
  return { state: 'recovered', file: held.file };
}

/*
 * ── THE EIGHTH SUITE — `src/core/core.test.ts`, ADDED BY `S67` ──────────────
 *
 * **IT IS IN `SUITES` BECAUSE OF WHAT WAS MEASURED, NOT BECAUSE IT LOOKED
 * RELEVANT.**
 *
 * `S58` fixed a round dying permanently when its proposer was removed between
 * raising and approving, and pinned it with two cases. **BOTH LIVE IN THAT FILE
 * AND THAT FILE WAS NOT IN THIS HARNESS — so the fix had two tests and nothing
 * that would notice if a later round weakened them.** `T-184`'s shape, in the
 * corpus rather than in a `from:` string. The controller found it by asking
 * *has this actually been fixed* about a fix already committed.
 *
 * **MEASURED BY `S67`, BY UNDOING THE FIX AT SOURCE AND RUNNING BOTH SETS: the
 * other seven suites reported 87 passed and 0 FAILED — this door noticed
 * NOTHING — while `core.test.ts` failed exactly the two `T-286` cases by
 * name.** So entry 36 could not have been written without the file, and the
 * entry alone would have scored STALE EXPECTATION for ever.
 *
 * **AND THE COST IS STATED RATHER THAN LEFT TO BE DISCOVERED: it roughly
 * doubles a run.** Measured: the other seven take 4.43s together; this file
 * takes 4.62s alone and carries 133 assertions against their 87. Call it two
 * and a quarter extra minutes across a baseline and 29 mutations, on a door a
 * person double-clicks. **That is the trade, and it is worth stating because
 * the next round to add a suite should have to make the same case.**
 */

/**
 * **WHAT AN ENTRY'S `kills:` LIST CLAIMED, AGAINST WHAT ACTUALLY DIED.**
 *
 *
 * `named` is the claim that held. `missed` is a name that RAN AND PASSED — the
 * entry credits a guard that observed the mutation and said nothing, and until
 * `S67` that fed no counter and left the report saying KILLED. `extra` is a
 * test that died without being named.
 *
 * **IT IS A FUNCTION SO THAT A TEST CAN CALL IT.** The scoring it feeds lives
 * inside the door, which no session may run (rule 1), so a pin on the decision
 * would otherwise have to grep for a sentence — and this file already says, of
 * its own `shaped()` ratchet, that a text match *is a ratchet and it is not a
 * proof*.
 */
export const scoreKills = (kills, failed) => ({
  named: kills.filter(t => failed.includes(t)),
  missed: kills.filter(t => !failed.includes(t)),
  extra: failed.filter(t => !kills.includes(t)),
});

/*
 * ── THE DOOR RUNS ONLY WHEN IT IS THE DOOR ──────────────────────────────────
 *
 * **EVERYTHING ABOVE THIS LINE IS DECLARATION; EVERYTHING BELOW IT IS THE RUN,
 * AND THE RUN HAPPENS ONLY WHEN THIS FILE IS THE PROCESS'S ENTRY POINT.**
 *
 *
 * `S58` was told by its brief to re-parse this corpus for rule 18. It
 * `import`ed this file to read `MUTATIONS` — **and because every statement
 * below was at the top level, the import RAN THE WHOLE DOOR.** It ran for two
 * minutes, its shell killed it mid-entry, and it left a mutation live in
 * `src/core/account.ts` on the money path. **A corpus that can only be read by
 * executing the door is the shape underneath that entire incident**, and it is
 * closed here rather than described: the corpus and the journal are exported,
 * a reader may import them, and importing measures nothing and writes nothing.
 *
 * **WHY THIS GUARD AND NOT A SEPARATE DATA FILE, WHICH IS WHAT `T-348` ASKED
 * THE ROUND TO CONSIDER.** A new file under `src/`, `scripts/` or
 * `contracts/test/` matching `/\.(ts|tsx|mjs)$/` is counted by
 * `scripts/edge-list.ts`'s `clientFiles` walk (`CLIENT_TREES`, `CLIENT_EXT`)
 * into `coverage.clientFilesScanned` in `docs/design/edges.json`. **MEASURED BY
 * That walk finds 298 files today and `edges.json` records 298.** So a
 * corpus in its own module makes the generated doc set stale the moment it is
 * created and refuses the WHOLE suite until `DOCS.command` is run — a door no
 * session may run, and one that would have held up a second round building in
 * this folder at the same time. The guard costs no file and reaches the same
 * end.
 *
 * **AND WHY THE IMPORTS AT THE TOP OF THIS FILE ARE THREE TO A LINE, WHICH
 * LOOKS LIKE CARELESSNESS AND IS NOT.** `docs/design/edges.json` records
 * exactly one scanned circuit call site in this file — `:542`, mutation 22's
 * `from:` text — and `S67` measured the gate firing on a two-line import
 * addition that moved it to `:544`: *1 line(s) differ … Run DOCS.command, then
 * run this again*, with the WHOLE suite refused until a person does. `S67`
 * could not run that door (rule 1) and a second round was building in this
 * folder at the time, so it kept the line count above `:542` unchanged instead.
 * **Splitting those imports moves `:542` and refuses every test in the
 * repository.** Add what you like BELOW that line; nothing above it is free.
 *
 * **AND IT FAILS LOUD RATHER THAN SILENT, WHICH IS THE ONLY VERSION OF THIS
 * WORTH HAVING.** `AUTHORITY-CHECK.command:196` runs `node
 * scripts/mutate-authority.mjs` and treats a zero exit as success
 * (`:202`) — so a guard that wrongly decided it had been imported would print
 * nothing, measure nothing, exit 0 and be scored as a clean run. **That is this
 * round's own subject wearing a different hat.** The `else if` below makes that
 * case throw instead: if this file is the thing node was pointed at and the
 * comparison still said otherwise, the door stops and says so.
 */
const RUN_AS_DOOR = (() => {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

function main() {
  /*
   * **THE REPORT'S DIRECTORY IS MADE BEFORE ANYTHING CAN WRITE A REPORT.**
   * `S67`'s money-safety pass, against `S67`. This `mkdirSync` used to sit
   * at the top level and the entry-point guard moved it into `beginMutation` —
   * **which is reached AFTER four `writeFileSync(reportAt, …)` sites, one of
   * them this round's own new refusal.** `logs/` is gitignored with no
   * `.gitkeep`, so on a fresh clone that refusal would have died with a node
   * stack and written no report at all, and the door would have shown a
   * non-zero exit and no evidence. The failure is not a red check, it
   * is an ABSENCE where evidence should be.
   */
  mkdirSync(OUT, { recursive: true });
  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };

  say(`MUTATING WHO IS ENTITLED TO ANSWER  —  ${new Date().toISOString()}`);
  for (const s of SUITES) say(`suite: ${s}`);
  say('');

  /*
   * **A DOOR THAT CANNOT ESTABLISH THE TREE IS CLEAN DOES NOT GO ON TO MEASURE
   * IT.** Every other refusal in this file stops before mutating; this
   * one stops before even reading the baseline, because the thing it cannot
   * vouch for is the source the baseline would be measured against.
   */
  const recovery = recoverFromLastRun(say);
  if (recovery.state === 'refused') {
    say('  A PREVIOUS RUN LEFT AN IN-FLIGHT RECORD BEHIND, AND THIS DOOR WILL NOT ACT');
    say('  ON IT, BECAUSE IT CANNOT PROVE WHAT ACTING ON IT WOULD DO.');
    say(`  ${recovery.why}.`);
    say('');
    say('  NOTHING WAS WRITTEN AND NOTHING WAS MEASURED. The stored copy of');
    say(`  ${recovery.file} is in logs/mutate-authority/in-flight.json, alongside the`);
    say('  hashes of the two texts this door would have accepted.');
    say('');
    /*
     * **RULE 19, AND THIS DOOR CANNOT SATISFY IT HONESTLY TODAY, SO IT SAYS SO
     * RATHER THAN NAMING A DOOR THAT WOULD NOT WORK.** `S67`'s own
     * money-safety pass caught the first version of these lines telling
     * the reader to run `AUTHORITY-CHECK.command` again — **which re-reads the
     * same record and refuses identically, for ever.** No `.command` in this
     * repository mentions `in-flight`. **Under rule 42a-i a state that lands
     * with a person becomes a `.command` and is never handed over as steps, so
     * the door that belongs here is OWED rather than missing by choice**, and
     * `BACKLOG.md` carries the row. `T-316` is the neighbouring case.
     */
    say('  NO DOOR CLEARS THIS RECORD TODAY. That is this door\'s defect and not your');
    say('  problem to solve by hand: running AUTHORITY-CHECK.command again reads the');
    say('  same record and refuses again. BACKLOG.md carries the row for the door that');
    say('  should stand here, under rule 42a-i.');
    say('  Until it exists this needs an engineer, who compares the two texts, keeps');
    say('  the right one, and CLEARS the record to {} — never deletes it, because `rm`');
    say('  is refused on this folder and an `rmSync` fails silently, leaving it behind.');
    writeFileSync(reportAt, lines.join('\n') + '\n');
    process.exit(1);
  }

  const clean = runSuite('baseline');
  if (!clean.ran) {
    say('  THE SUITES DID NOT RUN AT ALL. Nothing below means anything.');
    say(`  ${clean.why}.`);
    say('  the last thing vitest said:');
    for (const l of tail(clean.said)) say(`    ${l}`);
    writeFileSync(reportAt, lines.join('\n') + '\n');
    process.exit(1);
  }
  say(`baseline: ${clean.failures} failed | ${clean.passed} passed | ${clean.collected} collected`);
  if (clean.failures > 0) {
    say('');
    say('  THE SUITE IS RED BEFORE ANY MUTATION. A mutation cannot be judged against');
    say('  a suite that is already failing, so nothing was run.');
    for (const t of clean.failed) say(`    - ${t}`);
    writeFileSync(reportAt, lines.join('\n') + '\n');
    process.exit(1);
  }
  say('');

  /*
   * **THE `kills:` MATCHING IS BY TITLE ALONE, AND UNTIL NOW IT HELD BY NAMING
   * LUCK RATHER THAN BY CONSTRUCTION.**
   *
   * `clean.titles` is a flat set of strings with no file against them, and both
   * the pre-flight `stale expectation` check and the scoring match below compare
   * on the title alone. **A `kills:` entry naming a title that lives in a
   * DIFFERENT file from the mutation's subject would pass both checks and watch
   * nothing.** `SC15`'s test-coverage pass indexed every assertion title in the
   * baseline to its suite file and measured that zero titles collide across the
   * seven — true, and true by accident.
   *
   * **RULE 27: A PROPERTY THAT HOLDS BECAUSE NOBODY HAS WRITTEN THE CODE THAT
   * WOULD BREAK IT SAYS SO IN THOSE WORDS — OR IT NAMES WHAT ENFORCES IT.** This
   * is the enforcement, and it is cheaper than putting a file on all 22 entries:
   * the harness REFUSES if two suites ever carry the same title, because from
   * that moment on it cannot say which guard ran. It refuses BEFORE mutating, so
   * nothing is in the tree when it stops.
   */
  const named = new Set(MUTATIONS.flatMap(m => m.kills));
  const seenAt = new Map();
  for (const a of clean.byFile) {
    if (!named.has(a.title)) continue;
    if (!seenAt.has(a.title)) seenAt.set(a.title, []);
    seenAt.get(a.title).push(a.file);
  }
  /*
   * **TWO CORRECTIONS FROM `S56`'s OWN money-safety pass, BOTH ITS OWN
   * SUBJECT.** The first version compared every title in the baseline, so a
   * duplicate in a file no `kills:` entry names would have stopped the whole
   * corpus for a reason unrelated to any of it. And it compared FILES — `files.size
   * > 1` — so two assertions with the same title in ONE file passed, while
   * `known.has(t)` and `result.failed.includes(t)` are exactly as ambiguous there.
   * It now counts OCCURRENCES of the titles a mutation actually names.
   */
  const collisions = [...seenAt].filter(([, files]) => files.length > 1);
  if (collisions.length) {
    say('  TWO SUITES CARRY THE SAME ASSERTION TITLE.');
    say('  A `kills:` entry is matched by title and nothing else, so from here on');
    say('  this harness cannot say WHICH guard ran. Nothing was mutated.');
    for (const [title, files] of collisions) {
      say(`    "${title}" — named by a mutation, and it appears ${files.length} times:`);
      for (const f of files) say(`      ${f}`);
    }
    say('  Rename one of them, or give `kills:` a file. Either closes it.');
    writeFileSync(reportAt, lines.join('\n') + '\n');
    process.exit(1);
  }

  const known = new Set(clean.titles);
  let survived = 0;
  let stale = 0;
  /*
   * **THE FOURTH OUTCOME, WHICH THIS DOOR HAS ALWAYS HAD AND NEVER NAMED.**
   * `stale` is a mutation that could not be APPLIED — the text has moved, or the
   * test it names is gone. `notRun` is a mutation that WAS applied and whose run
   * measured nothing. They are different failures with different fixes and they
   * get different counters and different sentences, because a door that prints
   * one number for two states is the defect this whole round is about.
   */
  let notRun = 0;
  /*
   * **THE FIFTH OUTCOME: AN ENTRY WHOSE `kills:` LIST IS A CLAIM NOTHING COULD
   * REFUSE.** `T-337`, `SC19`, `S58`, closed here.
   *
   * A `kills:` name that RAN AND PASSED printed `! EXPECTED TO DIE AND DID NOT`
   * and fed no counter, so the exit code was unaffected and the report still
   * said KILLED. **The mutation was killed — by something else.** The entry's
   * claim that a NAMED guard scores that binding had been false for as long as
   * anybody left it there, and the only way it was ever found was somebody
   * re-measuring by hand. That is `C286`'s shape inside the instrument.
   *
   * **THIS IS NOT CHECK 4, WHICH IS ITS TWIN AND CATCHES THE OTHER HALF.**
   * Check 4 asks whether a named title EXECUTED and scores NOT RUN when it did
   * not. This asks whether a title that DID execute actually FAILED. A guard
   * that ran and passed has observed the mutation and said nothing about it.
   *
   * **AND THE OTHER DIRECTION — a catcher that died and is NOT named, printed
   * as `+ also:` — IS PRINTED PER ENTRY, FEEDS NO COUNTER, AND IS NOT FATAL.
   * THAT IS A DECISION RATHER THAN AN OVERSIGHT (rule 20)**, and the sentence
   * here first said *counted*, which was false and was caught by this round's
   * own money-safety pass under rule 14. For it: an under-claim is a false
   * statement in the corpus too, and nothing refuses it. Against it, which is
   * why it is not fatal: **MEASURED by `S67` over the run of 4 Sep 22:56 in
   * `logs/REPORT-MUTATE-AUTHORITY.txt` — ZERO over-claims and TWENTY-ONE
   * under-claims.** Making the over-claim fatal holds the tree exactly as it
   * stands; making the under-claim fatal turns this door red on twenty-one
   * lines that describe nothing wrong, and a mutation legitimately breaking a
   * test nobody predicted is evidence, not a defect. **The next round may
   * disagree and the number above is what it should argue with.**
   */
  let wrongClaim = 0;
  let aborted = false;

  for (const m of MUTATIONS) {
    if (wanted && !wanted.has(m.id)) continue;
    const path = join(ROOT, m.file);
    const before = readFileSync(path, 'utf8');
    const hits = before.split(m.from).length - 1;

    say(`${String(m.id).padStart(2, '0')}  ${m.binding}`);
    say(`    breaks: ${m.says}`);

    if (hits === 0) {
      say('    STALE MUTATION — that text is not in the file any more. NOT RUN.');
      say(`      ${m.file}: ${m.from.trim()}`);
      say('');
      stale += 1;
      continue;
    }
    if (hits > 1) {
      say(`    AMBIGUOUS TARGET — that text appears ${hits} times, so which copy was`);
      say('    broken is unknown. NOT RUN.');
      say('');
      stale += 1;
      continue;
    }
    const missing = m.kills.filter(t => !known.has(t));
    if (missing.length) {
      say('    STALE EXPECTATION — it names a test that is not in the suite:');
      for (const t of missing) say(`      "${t}"`);
      say('');
      stale += 1;
      continue;
    }

    /*
     * **THE MUTATED TEXT IS COMPUTED BEFORE THE RECORD IS WRITTEN, BECAUSE THE
     * RECORD STORES ITS HASH.** The record must be on disk before the file is,
     * or a run killed between the two lines leaves a mutation nothing knows
     * about — which is the ordinary case under a 45-second cap, not the exotic
     * one.
     */
    const after = before.replace(m.from, m.to);
    beginMutation(m.file, before, after);
    writeFileSync(path, after);
    let result;
    try {
      result = runSuite(`mutation-${m.id}`);
    } finally {
      endMutation(path, before);
    }

    /*
     * ── THE FOUR WAYS A RUN CAN HAVE MEASURED NOTHING, ALL SCORED AS ONE ─────
     *
     * **THE DOOR'S DOCTRINE IS THAT THERE ARE THREE OUTCOMES AND THAT COLLAPSING
     * THEM IS THE DEFECT** — `AUTHORITY-CHECK.command` prints that on both its
     * paths. It had a FOURTH, `0 ran`, and folded it into the loudest of the
     * three. These four tests are that outcome given a name. Each is cheap, each
     * catches a case the others miss, and all four are collected before anything
     * is said, so the report names every reason it has rather than the first.
     *
     *   1. NOTHING AT ALL was collected — `SC15` §2.5(1)'s subject, and the
     *      shape of mutation 22: a `globalSetup` throws, vitest writes a
     *      well-formed empty report, and every assertion in the corpus is absent.
     *   2. FEWER assertions than the baseline — `SC15` §2.5(2). This catches a
     *      collapse in a file no `kills:` entry names, which 1 and 4 both miss.
     *   3. A SUITE FILE that collected nothing and was not empty at the baseline.
     *      This is the half that never reached `!ran`: `flatMap(… ?? [])` hides a
     *      file that failed to COLLECT — a broken import, a module-scope throw —
     *      inside a report that parses and names it.
     *   4. A TITLE IN `kills:` ABSENT FROM WHAT RAN — the post-mutation twin of
     *      the pre-flight `stale expectation` check at the top of this loop.
     *      **`SC15`'s test-coverage pass proposed this against its own coarser count
     *      comparison and was right:** it is per-mutation, so it survives the case
     *      where one file collapses, another gains failures, and the totals
     *      happen to coincide. **A named guard that did not execute has observed
     *      nothing, whatever else ran.**
     *
     * A mutation that legitimately breaks its own guard file's import is scored
     * NOT RUN by 3 and 4. **That is the right answer and not a defect in it:** a
     * guard that did not run has not observed anything, and NOT RUN is the
     * outcome this door already defines as a failure.
     */
    const collapsed = [];
    if (!result.ran) collapsed.push(`${result.why}`);
    if (result.collected < clean.collected) {
      collapsed.push(`${result.collected} assertions collected where the baseline collected ${clean.collected}`);
    }
    const wentQuiet = result.emptyFiles.filter(f => !clean.emptyFiles.includes(f));
    if (wentQuiet.length) {
      collapsed.push(`a suite file collected nothing that collected at the baseline: ${wentQuiet.join(', ')}`);
    }
    const silent = m.kills.filter(t => !result.titles.includes(t));
    if (silent.length) {
      collapsed.push(`the guard it names did not execute: ${silent.map(t => `"${t}"`).join(', ')}`);
    }

    if (collapsed.length) {
      say('    NOT RUN. The mutation was applied and the run measured NOTHING here.');
      say('    This is not a survivor and it is not a kill: it says nothing whatever');
      say('    about the binding, because nothing executed to say it.');
      for (const c of collapsed) say(`      - ${c}`);
      if (result.failed.length) {
        /*
         * **AND WHAT DID GO RED IS PRINTED, NOT DISCARDED.** `S56`'s
         * test-coverage pass: when check 2, 3 or 4 fires because ONE file collapsed
         * while a named guard in another genuinely died, *"nothing executed to
         * say it"* is false and the list of tests that died was being thrown
         * away — `T-295`'s shape, one branch over.
         */
        say(`    ${result.failed.length} test(s) DID go red under it, and they are evidence even`);
        say('    though the run as a whole measured less than it should have:');
        for (const t of result.failed) say(`      ${m.kills.includes(t) ? '✓' : '+'} ${t}`);
      }
      say('    the last thing vitest said, which is where the reason is:');
      for (const l of tail(result.said)) say(`      ${l}`);
      notRun += 1;

      /*
       * **ABORT OR CONTINUE, AND HERE I DISAGREE WITH `SC15` §2.5(5) — RULE 20.**
       *
       * `SC15`'s fifth change is *ABORT rather than continue, per `C293` — whatever
       * stopped one suite will stop the next.* **`MUTATE.command:1912-1932` says
       * exactly that and is right about its own case**, where the causes it names
       * — a config error, a crashed worker, a stale artifact — are properties of
       * the tree and outlive any one mutation.
       *
       * **THE POSITION AGAINST, WHICH IS THE ONE THIS CODE TAKES:** the cause
       * measured here is NOT of that kind. Mutation 22 collapses the suite by its
       * OWN edit — it deletes a `pureCircuits` call site that `docs/design/edges.json`
       * records, so the doc-freshness `globalSetup` throws — and the restore in the
       * `finally` above puts that call site back before the next mutation runs.
       * An unconditional abort would therefore truncate every future run of this
       * door at entry 22 for ever, and 23 through 28 would go unscored on every
       * run — trading a lie for a blind spot.
       *
       * **SO THE INSTRUMENT MEASURES WHICH KIND IT IS RATHER THAN GUESSING.** The
       * tree is already restored, so one more run answers it: if the RESTORED tree
       * still collects nothing, the fault is not this mutation's and `C293`'s
       * reasoning applies exactly — abort. If it collects normally, the collapse
       * was this mutation's own doing, it is recorded as NOT RUN with its reason,
       * and the rest of the corpus is still worth scoring. It costs one extra
       * suite run, and only ever after something has already gone wrong.
       *
       * **Both positions are written down and neither is marked correct** — a
       * later round that decides the simpler rule is worth the blind spot has the
       * argument in front of it rather than a diff.
       */
      const recheck = runSuite(`recheck-${m.id}`);
      if (!recheck.ran || recheck.collected < clean.collected) {
        say('');
        say('    AND THE TREE IS BACK AND THE SUITE STILL DOES NOT RUN. Whatever');
        say('    stopped it is not this mutation, so it will stop the next one too.');
        say('    ABORTING rather than scoring nothing. C293.');
        say('    the last thing the recheck said:');
        for (const l of tail(recheck.said)) say(`      ${l}`);
        aborted = true;
        say('');
        break;
      }
      say(`    The restored tree runs (${recheck.collected} collected), so the collapse is`);
      say('    this mutation\'s own doing and the entries after it still mean something.');
    } else if (result.failures === 0) {
      say('    SURVIVED. The code was broken and every test still passed —');
      say('    nothing is watching this binding.');
      survived += 1;
    } else {
      const { named, missed, extra } = scoreKills(m.kills, result.failed);
      say(`    KILLED by ${result.failed.length} test${result.failed.length === 1 ? '' : 's'}:`);
      for (const t of named) say(`      ✓ ${t}`);
      for (const t of missed) say(`      ! EXPECTED TO DIE AND DID NOT: ${t}`);
      for (const t of extra) say(`      + also: ${t}`);
      if (missed.length) {
        wrongClaim += 1;
        say('    AND THIS ENTRY CLAIMS A GUARD THAT DID NOT SCORE IT. The name(s) marked');
        say('    ! above ran and PASSED, so whatever killed this mutation, it was not');
        say('    them. Either the guard has stopped covering the binding, or the entry');
        say('    names the wrong test. Both are holes in this instrument, and until now');
        say('    neither touched a counter.');
      }
      if (named.length === 0) {
        say('    NAMED NO TEST THAT ACTUALLY DIED. The mutation is killed, but by');
        say('    something other than the assertion written for it — worth reading.');
      }
    }
    say('');
  }

  say('-----------------------------------------------------------------------');
  /*
   * **THREE NUMBERS, THREE SENTENCES, NEVER ONE LINE.** The old summary put the
   * survivor count and the could-not-be-applied count in one sentence — and a
   * reader takes the survivor count away, because *survivor* is the word this
   * door attaches "hole" to on both of its paths. `T-285` is the same sentence in the payslip
   * door costing a `P1` its visibility: `0 survived, 1 not run` reads as a
   * procedural hiccup when what it means is that the only check on a binding
   * produced no evidence at all. They are three different failures with three
   * different fixes, so they get three lines and each says what it is.
   */
  say(`${survived} SURVIVED — the code was broken and nothing noticed. A hole in the product.`);
  say(`${stale} COULD NOT BE APPLIED — a mutation aimed at code that has moved. The`);
  say('   binding has been unguarded since the day it moved, which is a hole in the');
  say('   instrument that looks exactly like a passing check.');
  say(`${notRun} RAN AND MEASURED NOTHING — the mutation went in and no assertion came`);
  say('   back. This says nothing about the product in either direction.');
  say(`${wrongClaim} NAMED A GUARD THAT RAN AND PASSED — the mutation died, but not by the`);
  say('   test the entry credits. This one is about the corpus, not the product:');
  say('   the binding may still be watched, and the claim that THIS guard watches');
  say('   it is false.');
  if (aborted) {
    say('');
    say('AND THE RUN STOPPED EARLY. Every entry after the last one above was never');
    say('scored, and this report does not describe them.');
  }
  say('');
  say(survived + stale + notRun + wrongClaim === 0 && !aborted
    ? 'Every binding has a test that notices when it is broken, and every entry names it.'
    : 'Read the entries above. THE FOUR NUMBERS ARE FOUR DIFFERENT FAILURES, and'
      + ' only the first is about the product. The other three are about this door.');
  writeFileSync(reportAt, lines.join('\n') + '\n');
  console.log(`\nwritten to ${reportAt}`);
  process.exit(survived + stale + notRun + wrongClaim === 0 && !aborted ? 0 : 1);
}

if (RUN_AS_DOOR) {
  main();
} else if (/[\\/]mutate-authority\.mjs$/.test(process.argv[1] ?? '')) {
  /*
   * Node was pointed at this file and the comparison above still said it was an
   * import. Rather than exit 0 having measured nothing — which the door would
   * score as a clean run — refuse.
   */
  throw new Error(
    'mutate-authority: node was started on this file and its entry-point check did not '
      + 'recognise it, so the door would have exited without running. Nothing was measured. '
      + 'Run AUTHORITY-CHECK.command again from the repository root.',
  );
}

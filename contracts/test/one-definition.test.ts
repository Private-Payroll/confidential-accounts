/**
 * ONE DEFINITION. The mechanical answer to this project's oldest failure.
 *
 * Eleven times now, a rule has been written twice and the copies have drifted:
 * M-50, M-55, M-58, M-61, M-65, M-72, M-75, M-97, M-104, and the two before
 * those that started the list. Every previous fix was "be more careful", and
 * being more careful has never once worked — the backlog says so in as many
 * words.
 *
 * The worst instance, M-104, could not have been caught by care at all. The
 * signer generation was chained one way inside the contract and another way in
 * TypeScript. Both copies were correct in isolation, the typechecker could not
 * see across the language boundary, and the SIMULATION agreed with itself
 * because one function served both sides of it. On chain it would have seated
 * every surviving signer at a generation the contract never adopted: an account
 * with money in it and nobody able to prove membership. Not the person removed
 * — everybody.
 *
 * So this file is not another rule. It is a check that fails.
 *
 * WHAT IT DOES.
 *
 * 1. Every scheme both sides compute is listed below with both call sites, and
 *    asserted to agree on real inputs.
 * 2. **The list is checked against the compiled contract.** Adding an exported
 *    pure circuit without registering it here fails this file — so the next
 *    person to invent a shared rule cannot quietly leave the second copy
 *    unchecked, because there is nowhere to put it that the build ignores.
 *
 * Point 2 is the whole value. Point 1 is a test; point 2 is a ratchet.
 *
 * WHAT POINT 1 IS NOT, AND THIS FILE SAID OTHERWISE UNTIL `S28`. `C306`,
 * It is not a check between two implementations of a rule. Every
 * `mirrored` entry's client side calls the contract's own generated function.
 * **RE-ANCHORED AND COMPLETED BY `S44`** — it named four lines, three of which
 * had drifted, and there are ten mirrored entries. Each anchor below is the
 * adapter's SIGNATURE line and the `pureCircuits.*` call is the line under it,
 * which is the convention the four original anchors used:
 * `src/midnight/commitments.ts:99`, `:116`, `:130`, `:198`, `:204`, `:262`,
 * `:266`, `:295`, `:299`, and `src/midnight/payout-tree.ts:161`. So BOTH SIDES
 * OF EVERY MIRROR ARE THE CIRCUIT. Change the circuit's body and the two sides
 * move together and the mirror stays green. Measured, not suspected: two
 * mutations of these very circuits scored `SURVIVED` on 31 Aug with all 232
 * tests passing.
 *
 * What a mirror genuinely pins is the ADAPTER — that the TypeScript wrapper
 * passes the right arguments, in the right order, in the right encoding, to
 * the right circuit. That is real, it is what M-104 would have needed, and it
 * is worth every line here. It is not a check on what the circuit computes.
 *
 * WHAT THE CIRCUIT COMPUTES IS PINNED IN
 * `contracts/test/commitments.test.ts`, under *what a commitment names, which
 * no mirror can check* — by properties written out by hand rather than by a
 * second call to the same function.
 */
import { describe, it, expect } from 'vitest';
import { pureCircuits } from '../managed/contract/index.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { SimulatedCommitments } from '../../src/core/ledger.js';
import { toHex, fromHex } from '../../src/core/crypto.js';
import { payoutLeafOf } from '../../src/midnight/payout-tree.js';

const bytes = (n: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, i) => (i + n) & 0xff);
const hex = (b: Uint8Array) => toHex(b);

const PK = bytes(1);
/* A signer's own 32-byte secret, which is what `signerPublicKey` hashes. */
const SIGNING_SECRET = bytes(3);
const BLINDING = bytes(2);
const LEAF = bytes(4);
const VAULT = bytes(5);
const BATCH = bytes(6);
const SALT = bytes(7);
const PAYLOAD = bytes(8);
const ASSET_KEY = bytes(9);
/* A run's payout-tree root. */
const ROOT = bytes(10);
/* 'GBP', zero padded — the encoding `core/assets.ts` owns. */
const GBP = Uint8Array.from({ length: 32 }, (_, i) => 'GBP'.charCodeAt(i) || 0);

/**
 * Every exported pure circuit, and what the TypeScript side does about it.
 *
 * `mirrored` means the client has a call site for it and the two must agree —
 * that is the drift this file exists to prevent. Read the header on what such
 * an entry does and does not pin: it holds the adapter, not the circuit body.
 *
 * `contractOnly` means the client never recomputes it, and the reason is
 * recorded. Marking something `contractOnly` is a claim that no second copy
 * exists, so it is not a way to opt out of the check: if a TypeScript copy is
 * ever written, this entry is a lie and the note is where somebody will read it.
 */
type Entry =
  | { circuit: string; mirrored: () => { fromContract: string; fromClient: string } }
  | { circuit: string; contractOnly: string };

const SCHEMES: Entry[] = [
  {
    circuit: 'signerLeaf',
    mirrored: () => ({
      /*
       * Three arguments since V-33. The scope is passed EXPLICITLY on both
       * sides rather than left to each default, because this test exists to
       * prove the two schemes agree — and two defaults that happen to match
       * would prove only that they happen to match today.
       */
      fromContract: hex(pureCircuits.signerLeaf(PK, BLINDING, pureCircuits.allVaults())),
      fromClient: MidnightCommitments.signerLeaf(
        hex(PK), hex(BLINDING), MidnightCommitments.allVaults()),
    }),
  },
  {
    /*
     * `stateCommitmentOf` AND `appendEntries` USED TO BE HERE, and they are
     * gone for two different reasons worth keeping apart.
     *
     * `stateCommitmentOf` committed to a balance and an entry digest together,
     * which was right while an account had one balance. M-125 split it into
     * `balanceCommitmentOf` per asset, because one combined commitment would
     * mean moving dollars rewrote the commitment covering the euro balance.
     * `C292` then removed the balance entirely, and `balanceCommitmentOf` with
     * it — see the note further down where its row stood.
     *
     * `appendEntries` chained the entry log, and M-128 deleted the chain: to
     * append to it you had to prove its current value, so two settlements
     * conflicted even when they moved different money. The chain holds an
     * append-only set of movement commitments now, and there is no shared rule
     * left to keep in step — which is the safest kind.
     */
    circuit: 'assetKeyOf',
    mirrored: () => ({
      fromContract: hex(pureCircuits.assetKeyOf(GBP, BLINDING)),
      fromClient: MidnightCommitments.assetKey('GBP', hex(BLINDING)),
    }),
  },
  /*
   * `balanceCommitmentOf` STOOD HERE, mirrored against
   * `MidnightCommitments.balanceCommitment`. `C292`, `S26` removed both sides:
   * the account keeps no balance, so there is no scheme left to keep in step.
   *
   * The reason it was here survives and is worth restating, because it is what
   * this whole file is for: decision 0004 records THREE definitions of one
   * commitment scheme, all compiling, none agreeing. A scheme that exists on
   * two sides is checked here or it drifts.
   */
  {
    /*
     * MIRRORED SINCE M-125, where it was `contractOnly` before, and the change
     * of category is the point rather than a detail.
     *
     * The old note said "the chain recomputes it from witnesses at execute
     * time; the client never produces the commitment itself". That stopped
     * being true the moment `propose` had to be verified against what the chain
     * recorded, and it is now false in a second place: `movements` holds this
     * value, so the client computes it to check the audit trail. Two copies
     * that must agree, which is exactly what this file is for.
     */
    circuit: 'changeCommitmentOf',
    mirrored: () => ({
      fromContract: hex(pureCircuits.changeCommitmentOf(ASSET_KEY, 20_000n, BATCH, SALT)),
      fromClient: MidnightCommitments.changeCommitment(hex(ASSET_KEY), 20_000n, hex(BATCH), hex(SALT)),
    }),
  },
  {
    /*
     * The client MUST compute this one, which is what makes it the most
     * dangerous entry in the list.
     *
     * A signer's device needs a proposal's id to approve it, and the proposer
     * needs it before the transaction is submitted. If the two sides derived it
     * differently, an approval would be burned against an id the contract does
     * not hold — and the failure would look like "you have not approved" on a
     * round that has already cost a fee.
     */
    circuit: 'proposalIdOf',
    mirrored: () => ({
      /*
       * The VAULT is passed explicitly on both sides since V-32.
       *
       * Both schemes default it to `noVault()`, and relying on those defaults
       * here would make this test agree by coincidence rather than by
       * construction — which is the exact failure this file exists to catch.
       */
      fromContract: hex(pureCircuits.proposalIdOf(PAYLOAD, pureCircuits.noVault(), SALT)),
      fromClient: MidnightCommitments.proposalId(
        hex(PAYLOAD), hex(SALT), MidnightCommitments.noVault()),
    }),
  },
  {
    /*
     * M-104's `generationAfter` USED TO BE HERE, and M-106 deleted the rule.
     *
     * It is worth one line rather than a silent absence: it was the most
     * expensive near-miss in this file's history — chained one way in the
     * contract and another in TypeScript, invisible to both typecheckers and
     * to the simulation, and it would have locked every surviving signer out
     * of an account with money in it. It existed only because a removal
     * re-seated everybody. Nothing re-seats anybody now, so the safest version
     * of that shared rule turned out to be no shared rule.
     */
    circuit: 'slotOf',
    contractOnly:
      'the slot is DERIVED inside the circuit from the membership path\'s own left/right ' +
      'flags, so a caller cannot supply one and the client never computes one. It is pinned ' +
      'against the runtime\'s own indexing in signer-governance.test.ts, which is a check ' +
      'that the derivation is right — not a second implementation of it.',
  },
  {
    circuit: 'vacantSlot',
    contractOnly:
      'a fixed marker a removal writes into the slot it frees. The client does not RECOMPUTE ' +
      'it — witnesses.ts reads it straight off pureCircuits, because a copy of this constant ' +
      'in TypeScript is a shared value written twice and that is exactly M-104.',
  },
  {
    /*
     * **THIS WAS `contractOnly` UNTIL `S34`, AND THE NOTE WAS WRONG BY THEN.**
     *
     *
     * It said the client *holds the result rather than recomputing it*. It did
     * not hold it: `src/core/account.ts` and `src/web/App.tsx` passed an
     * ed25519 public key into `signerLeaf`, which is a SECOND ANSWER to what a
     * signer's public identity is, and the entry that was supposed to make a
     * second copy impossible to leave unchecked had a note saying there wasn't
     * one. **A `contractOnly` note is a claim, and this is what it costs when
     * it is stale** — point 2 of this file's header is a ratchet only while the
     * notes are true.
     *
     * There is now one adapter, `src/midnight/commitments.ts`, and every writer
     * goes through it. Mirrored, so its arguments and encoding are held.
     */
    circuit: 'signerPublicKey',
    mirrored: () => ({
      fromContract: hex(pureCircuits.signerPublicKey(SIGNING_SECRET)),
      fromClient: MidnightCommitments.signerPublicKey(hex(SIGNING_SECRET)),
    }),
  },
  {
    /*
     * **MIRRORED SINCE `S44`. IT WAS `contractOnly` UNTIL THEN AND THE NOTE WAS
     * TRUE OF THE SIMULATED SCHEME AND SILENT ABOUT THE MIDNIGHT ONE — WHICH IS
     * THE GAP `C373` LIVED IN.**
     *
     * There are still two client spellings and that has not changed: the
     * simulated scheme keeps its own `sha256`, deliberately, and decision 0004
     * is why (`core/` cannot import generated Midnight code). What was missing
     * was the MIDNIGHT spelling — there was none, so `AccountService` used the
     * simulated one on both wirings and named its governance rounds with a hash
     * the contract has never computed. `propose` takes the payload hash as an
     * opaque argument, so the round was raised, approved and paid for, and
     * `amendSigner` refused at the end.
     *
     * So this entry now carries BOTH halves, and they are separate assertions:
     * the Midnight adapter EQUALS the circuit (here), and the simulated scheme
     * does NOT (the test at the bottom of this file, which is unchanged in
     * kind and now covers all four).
     */
    circuit: 'signerAddPayload',
    mirrored: () => ({
      fromContract: hex(pureCircuits.signerAddPayload(LEAF)),
      fromClient: MidnightCommitments.signerAddPayload(hex(LEAF)),
    }),
  },
  {
    /*
     * V-32/V-33's two SENTINELS, and they are `contractOnly` for the same
     * reason `vacantSlot` is: `src/midnight/commitments.ts` reads both straight
     * off `pureCircuits` rather than recomputing them, so there is no second
     * Midnight-side copy to drift.
     *
     * `core/ledger.ts` DOES hold its own values for these, and deliberately —
     * the simulated scheme cannot import generated Midnight code (decision
     * 0004) and only ever compares its own sentinels with its own. As with the
     * payload circuits below, the real property is that the two stay APART, not
     * that they agree.
     */
    circuit: 'allVaults',
    contractOnly:
      'the scope every signer carries unless narrowed. midnight/commitments.ts reads it off ' +
      'pureCircuits rather than recomputing it; core/ledger.ts holds a deliberately separate ' +
      'simulated sentinel (decision 0004).',
  },
  {
    circuit: 'noVault',
    contractOnly:
      'the scope a proposal names when it concerns no vault — governance and the account\'s ' +
      'own ledger. Same arrangement as allVaults: read off pureCircuits on the Midnight side, ' +
      'a deliberately separate sentinel in the simulation.',
  },
  {
    /*
     * V-41. The client BUILDS the tree the signers approve and the contract
     * RECOMPUTES each leaf as it is claimed, so this is the most load-bearing
     * mirrored entry in the file: two derivations would produce a payroll that
     * collects approvals, costs a fee, and then cannot pay anybody.
     */
    circuit: 'payoutLeaf',
    mirrored: () => ({
      fromContract: hex(pureCircuits.payoutLeaf(PAYLOAD, SALT)),
      fromClient: payoutLeafOf({ details: hex(PAYLOAD), nonce: hex(SALT) }),
    }),
  },
  {
    /*
     * The chain's answer to "has this person been paid", and the client
     * CALLS it rather than deriving it — `src/midnight/run-status.ts` takes the
     * circuit as an argument and never reimplements it.
     *
     * A second derivation would not fail loudly. It would produce a dashboard
     * confidently reporting somebody unpaid who has their salary, or paid who
     * does not, after a crash, when there is nothing else to check against.
     *
     * `contractOnly` rather than mirrored, because asserting the contract
     * equals itself would be a test that cannot fail. What holds the rule is
     * that no second copy exists; `run-status.test.ts` pins the answers against
     * a real run.
     */
    circuit: 'paidMovementOf',
    contractOnly:
      'the client calls this circuit rather than deriving the value; run-status.ts takes it as ' +
      'an argument and never reimplements it.',
  },
  {
    /*
     * V-41. Bound into the proposal id, so a claim proves the root AND the
     * payee count are the approved ones. The client computes it to raise the
     * proposal; the contract recomputes it on every claim.
     */
    /*
     * **THIS ENTRY WAS `contractOnly` UNTIL `S47`, AND ITS SENTENCE WAS TRUE
     * WHEN WRITTEN AND FALSE AFTERWARDS.** It read: *"the client calls
     * this circuit rather than deriving the payload a second way — there is no
     * TypeScript copy to disagree with."*
     *
     * **WHAT CHANGED IS NOT THE MIDNIGHT SIDE.** `MidnightCommitments.runPayload`
     * is still one line calling this circuit and must stay that way — a second
     * derivation is a proposal id no payment can match. What changed is that
     * `runPayload` joined `CommitmentScheme`, because until it did, nothing
     * typed to the `Ledger` boundary could raise a payroll run at all and every
     * one the product raised went through the GOVERNANCE door carrying a
     * payload hash `recordPayment` can never reproduce. `SimulatedLedger` now
     * raises runs, so a simulated spelling exists — deliberately different, like
     * the four governance payloads `S44` moved across, and asserted to differ
     * below.
     */
    circuit: 'runPayload',
    mirrored: () => ({
      fromContract: hex(pureCircuits.runPayload(ROOT, 5n, 1_800_000_000n, 1_800_604_800n)),
      fromClient: MidnightCommitments.runPayload(hex(ROOT), 5n, 1_800_000_000n, 1_800_604_800n),
    }),
  },
  {
    /*
     * **AND THE NAME DIFFERS ON THE CLIENT SIDE, WHICH IS WHY THIS ENTRY EARNS
     * ITS KEEP TWICE OVER.** The circuit is `setThresholdPayload`; the
     * scheme method is `signerThresholdPayload`. Three of the four governance
     * payloads are renamed across that boundary and every one of them returns
     * 32 bytes for the arguments it is handed, so a swap is silent everywhere
     * except here.
     *
     * **THE TWO LITERALS ARE WRITTEN OUT, `3n` AGAINST `3`, RATHER THAN
     * CONVERTED ON BOTH SIDES.** The scheme takes a `number` and the circuit a
     * `Uint<64>`, so the adapter does a `BigInt()` — and a conversion both
     * sides perform is a conversion neither side pins.
     */
    circuit: 'setThresholdPayload',
    mirrored: () => ({
      fromContract: hex(pureCircuits.setThresholdPayload(3n)),
      fromClient: MidnightCommitments.signerThresholdPayload(3),
    }),
  },
  {
    /*
     * **THIS ENTRY SAID *NO CLIENT COPY EXISTS AT ALL — NOT A DIFFERENT SCHEME,
     * NONE*, AND IT WAS FALSE WHEN IT WAS WRITTEN.** `T-203`, found by `S43`,
     * fixed here. `src/core/ledger.ts` held one and `src/core/account.ts:1392`
     * called it, and `src/core/account.ts:1455` called it again to find the
     * approved round.
     *
     * **AND IT WAS WORSE THAN A STALE SENTENCE BECAUSE IT INSTRUCTED.** It told
     * the next round it was safe to mirror this circuit in TypeScript, which is
     * exactly what had already been done and exactly what produced `C373`.
     * Fixing the defect and leaving the instruction is how the defect returns,
     * so the two land in the same round.
     *
     * What is true after `S44`: both schemes carry this payload, the simulated
     * one as its own deliberately-different `sha256` and the Midnight one as a
     * call to this circuit — asserted here, and asserted to differ below. A
     * vault-threshold round is reachable through `SimulatedLedger` as well as
     * through the contract, which is why it belongs on `CommitmentScheme`
     * rather than on `RunCommitments` (`src/midnight/commitments.ts:58-67` is
     * the rule that decides it).
     */
    circuit: 'setVaultThresholdPayload',
    mirrored: () => ({
      fromContract: hex(pureCircuits.setVaultThresholdPayload(VAULT, 2n)),
      fromClient: MidnightCommitments.vaultThresholdPayload(hex(VAULT), 2),
    }),
  },
  {
    /* The client name is `signerRemovePayload`; the circuit's is this. */
    circuit: 'removeSignerPayload',
    mirrored: () => ({
      fromContract: hex(pureCircuits.removeSignerPayload(LEAF)),
      fromClient: MidnightCommitments.signerRemovePayload(hex(LEAF)),
    }),
  },
  {
    /*
     * **NO CLIENT COPY, AND `S44` CHECKED IT RATHER THAN INHERITING IT:**
     * `grep` of `src/` returns no `adoptVaultPayload` outside `scripts/` and
     * the contract's own tests, and `src/core/account.ts` raises no adopt
     * round. So this stays `contractOnly` — a mirror for a caller that does not
     * exist would be a definition invented to fill a table, which is the rule
     * at `src/midnight/commitments.ts:58-67`.
     *
     * **THE DAY AN ADOPT ROUND IS BUILT IT NEEDS `C373`'s TREATMENT, AND THE
     * PATTERN IS NOW IN THIS FILE RATHER THAN IN A SENTENCE:** add the method
     * to `CommitmentScheme`, implement it in `MidnightCommitments` as one line
     * that calls this circuit, keep the simulated side separate, and turn this
     * entry into a `mirrored` one like the four above. A second derivation in
     * TypeScript would let a company approve one vault's adoption on their
     * screens and adopt another on chain.
     */
    circuit: 'adoptVaultPayload',
    contractOnly:
      'NO METHOD ON EITHER SCHEME DERIVES THIS, and that is now read rather than grepped: ' +
      'the reverse ratchet below maps every member of both CommitmentScheme objects to a ' +
      'circuit, and nothing maps here. No product caller raises an adopt round. The day one ' +
      'is built, mirror it the way the four governance payloads above are mirrored — and the ' +
      'ratchet will refuse until you do.',
  },
  {
    /*
     * S6a, and one degree more dangerous than its twin. A retirement round is
     * raised on a device and CLAIMED by the vault, which passes the salt back
     * in as a public argument — so a client that derived this payload a second
     * way would raise rounds the vault cannot complete, and the failure would
     * appear at the vault rather than where the mistake was made.
     *
     * **NO CLIENT COPY, CHECKED BY `S44` THE SAME WAY ITS TWIN WAS**, and the
     * same instruction: when a retire round is built, mirror it as the four
     * governance payloads above are mirrored.
     */
    circuit: 'retireVaultPayload',
    contractOnly:
      'NO METHOD ON EITHER SCHEME DERIVES THIS, read by the reverse ratchet below rather ' +
      'than asserted by hand. A retirement round is claimed by the vault from the salt, so ' +
      'a second derivation here produces rounds that can never be run — mirror it instead, ' +
      'and the ratchet will refuse until you do.',
  },
];

describe('one definition: the contract and the client agree', () => {
  for (const entry of SCHEMES) {
    if ('contractOnly' in entry) {
      it(`${entry.circuit} is the contract's alone — ${entry.contractOnly.slice(0, 48)}…`, () => {
        expect(entry.contractOnly.length).toBeGreaterThan(20);
      });
      continue;
    }
    it(`${entry.circuit} produces the same value on both sides`, () => {
      const { fromContract, fromClient } = entry.mirrored();
      expect(fromClient).toBe(fromContract);
    });
  }

  it('EVERY exported pure circuit is registered here', () => {
    /*
     * THE RATCHET, and the only part of this file that prevents a twelfth
     * instance rather than catching the eleven that already happened.
     *
     * A shared rule becomes dangerous at the moment somebody adds it to the
     * contract and writes a TypeScript copy. This makes the first half of that
     * fail the build until the rule is registered, so the second half cannot
     * happen quietly. It reads the COMPILED artifact, so it cannot be satisfied
     * by editing a list and forgetting the circuit, or the reverse.
     */
    const compiled = Object.keys(pureCircuits).sort();
    const registered = SCHEMES.map(e => e.circuit).sort();
    expect(registered).toEqual(compiled);
  });

  /**
   * ── THE RATCHET, THE OTHER WAY ROUND. `T-208`, `S46`, board row `2y7f2` ────
   *
   * **THE ONE ABOVE RUNS FROM THE COMPILED ARTIFACT TO THE REGISTRY. NOTHING
   * RAN THE OTHER WAY, AND THE COST OF THAT IS MEASURED RATHER THAN FEARED:
   * THIS FILE'S `contractOnly` NOTES HAVE BEEN FALSE THREE TIMES AND TWO OF
   * THOSE WERE `P0`s.** `C328` — the note said the client held the result while
   * `account.ts` and `App.tsx` passed an ed25519 key into `signerLeaf`. `T-203`
   * / `C373` — the note said no client copy existed at all while
   * `src/core/ledger.ts:856` held one that `account.ts:1392` and `:1455`
   * called. And the add/remove/threshold notes were true of the SIMULATED
   * scheme and silent about the Midnight one, which is the gap `C373` lived in.
   * **Each was found by a person, and this is the file written to find them.**
   *
   * **WHAT THIS DOES.** Every member of `CommitmentScheme` — read as DATA off
   * both implementations, never off `Function.prototype.toString` (rule 41,
   * The same artifact gives two different answers under `tsx` and
   * under `vitest`, so a binding is not a fact) — is declared here against the
   * circuit it derives and HOW — mirrored, a pass-through that reads the
   * circuit, or no derivation at all. Three assertions close the loop, and the
   * FIRST is the ratchet: **add a method to either scheme and this file is red
   * until it is declared.**
   *
   * **AND `contractOnly` DOES NOT MEAN *NO SCHEME MEMBER*, WHICH `S46` READ
   * WRONG ON ITS FIRST PASS AND ITS OWN AUDITOR CAUGHT.** It means no second
   * DERIVATION: `noVault` and `allVaults` are `contractOnly` AND are scheme
   * members, because the Midnight side reads them off `pureCircuits` and the
   * simulated side holds a deliberately separate sentinel. Seven entries are
   * `contractOnly`; five of them no scheme touches, and those five are the list
   * the third assertion pins.
   *
   * **AND `S44`'s TWO `'(checked by grep, S44)'` NOTES ARE GONE, WHICH WAS HALF
   * OF `T-208`.** A rule-42a value with no instrument behind it, in the one
   * file whose job is to be an instrument. What replaced them is the sentence
   * this table lets a reader check.
   *
   * ── WHAT IT STILL CANNOT SEE, WRITTEN HERE RATHER THAN LEFT TO ROT A FOURTH
   *    TIME. `T-277` ───────────────────────────────────────────────────────
   *
   * **THIS READS METHOD NAMES ON THE TWO SCHEME OBJECTS. `C373`'s SECOND COPY
   * WAS NOT ON A SCHEME.** It was a module-scope function in
   * `src/core/ledger.ts:856` (`simulatedVaultThresholdPayload`), called
   * directly, **and it was named
   * `vaultThresholdPayload` while the circuit is `setVaultThresholdPayload`** —
   * so a grep for the circuit's name would not have found it either, which is
   * the point `T-208` makes about why the obvious fix does not work.
   * (`src/core/ledger.ts:856`, read at source by `S46`; `T-208`'s own citation
   * of `:789` predates `S44`'s move and is stale. `T-279`.)
   *
   * **SO THE HONEST CLAIM THIS FILE NOW MAKES IS NARROWER THAN *NO SECOND COPY
   * EXISTS*. IT IS *NO SECOND COPY EXISTS ON A SCHEME*.** A derivation written
   * at module scope, in a screen, or in a service is invisible to every
   * assertion in this file, and the only reason that is survivable today is
   * that `S44` moved the four governance payloads behind
   * `CommitmentScheme` — which is a fact about where the code happens to be,
   * not an enforcer. Rule 27, and it is filed as `T-277` rather than claimed
   * as covered.
   */
  const NO_CIRCUIT = null;

  /**
   * Every member of `CommitmentScheme`, and what it does about a circuit.
   *
   * `kind` is the whole content of this table and it has three values, which
   * are the three relationships a scheme member can have with the registry
   * above:
   *
   *   · `mirrored` — the registry entry is a `mirrored` one and this member is
   *     its client side. Read that entry's header on what a mirror pins.
   *   · `passthrough` — the registry entry is `contractOnly`, and that is
   *     correct: the Midnight member reads the value straight off
   *     `pureCircuits` rather than recomputing it, and the simulated member
   *     holds a deliberately separate value (decision 0004). **A member being
   *     present is NOT evidence of a second derivation**, which is the reading
   *     `S46` got wrong first and its own auditor caught.
   *   · `NO_CIRCUIT` — not a derivation at all, with the reason beside it.
   *
   * **AND `NO_CIRCUIT` IS A SELF-CERTIFIED EXEMPTION, SAID PLAINLY BECAUSE THE
   * ALTERNATIVE IS A READER ASSUMING IT IS NOT.** This round's test-coverage pass
   * added a real derivation to both schemes, declared it `NO_CIRCUIT` with the
   * words *"internal helper"*, and every assertion below stayed green. Nothing
   * inside a repository can tell a helper from a derivation; **what this table
   * buys is that somebody had to WRITE the four words, in this file, next to
   * the header that says what it costs to write them falsely.**
   */
  const SCHEME_MEMBERS: {
    method: string; circuit: string | null; kind: 'mirrored' | 'passthrough' | 'none'; why?: string;
  }[] = [
    { method: 'signerPublicKey', circuit: 'signerPublicKey', kind: 'mirrored' },
    { method: 'signerLeaf', circuit: 'signerLeaf', kind: 'mirrored' },
    { method: 'assetKey', circuit: 'assetKeyOf', kind: 'mirrored' },
    { method: 'runPayload', circuit: 'runPayload', kind: 'mirrored' },
    { method: 'proposalId', circuit: 'proposalIdOf', kind: 'mirrored' },
    { method: 'changeCommitment', circuit: 'changeCommitmentOf', kind: 'mirrored' },
    { method: 'signerAddPayload', circuit: 'signerAddPayload', kind: 'mirrored' },
    /* The client's name and the circuit's differ for these three. That is
     * exactly the drift a name-matching grep cannot see, and the reason this
     * table is a declared map rather than a comparison of two name sets. */
    { method: 'signerRemovePayload', circuit: 'removeSignerPayload', kind: 'mirrored' },
    { method: 'signerThresholdPayload', circuit: 'setThresholdPayload', kind: 'mirrored' },
    { method: 'vaultThresholdPayload', circuit: 'setVaultThresholdPayload', kind: 'mirrored' },
    {
      method: 'noVault', circuit: 'noVault', kind: 'passthrough',
      why: 'midnight/commitments.ts:184-190 reads both sentinels off pureCircuits; core/ledger.ts '
        + 'holds its own, deliberately apart (decision 0004)',
    },
    {
      method: 'allVaults', circuit: 'allVaults', kind: 'passthrough',
      why: 'the same arrangement as noVault, and the entry above says so in the registry',
    },
    {
      method: 'describe', circuit: NO_CIRCUIT, kind: 'none',
      why: 'a sentence for a log line and a screen, not a value the chain compares against',
    },
  ];

  /** The registry's own answer about each circuit, read off `SCHEMES`. */
  const contractOnlyCircuits = new Set(
    SCHEMES.filter(e => 'contractOnly' in e).map(e => e.circuit));

  it('EVERY member of BOTH schemes is declared here — the reverse ratchet', () => {
    /*
     * **THE HALF THAT PREVENTS RATHER THAN CATCHES.** A `CommitmentScheme`
     * method written with a hand-rolled derivation and no registry mirror left
     * this file green before this line existed. It cannot now: the keys are
     * read off the objects themselves, so adding one anywhere — to the
     * interface, to either implementation — reddens `contracts/test/` until
     * somebody says which circuit it derives and how.
     *
     * Both objects, separately, because an interface has no runtime shape and
     * a member added to one implementation and not the other is exactly the
     * asymmetry the add/remove/threshold notes hid before `S44`.
     */
    const declared = SCHEME_MEMBERS.map(m => m.method).sort();
    expect(Object.keys(SimulatedCommitments).sort()).toEqual(declared);
    expect(Object.keys(MidnightCommitments).sort()).toEqual(declared);
  });

  it('every declared member names a registered circuit, and its kind matches the registry', () => {
    const registered = new Set(SCHEMES.map(e => e.circuit));
    for (const m of SCHEME_MEMBERS) {
      if (m.circuit === NO_CIRCUIT) {
        expect(m.kind).toBe('none');
        expect(m.why, `${m.method} carries no circuit and no reason`).toBeTruthy();
        continue;
      }
      expect(registered, `${m.method} names ${m.circuit}, which is not a circuit`)
        .toContain(m.circuit);
      /*
       * **THE KIND AND THE REGISTRY MUST AGREE.** A member declared `mirrored`
       * against an entry the registry calls `contractOnly` is one of the two
       * halves saying the client has a copy and the other saying it has none —
       * which is the exact contradiction this file's notes have carried three
       * times. Whichever is wrong, a person must decide which, here.
       */
      const isContractOnly = contractOnlyCircuits.has(m.circuit);
      expect(
        m.kind,
        `${m.method} is declared ${m.kind} but ${m.circuit} is registered as `
        + `${isContractOnly ? 'contractOnly' : 'mirrored'} above. Either the entry's note is `
        + `false or this row is — and a passthrough must say, in its "why", that the Midnight `
        + `side reads the circuit rather than recomputing it.`,
      ).toBe(isContractOnly ? 'passthrough' : 'mirrored');
      if (m.kind === 'passthrough') {
        expect(m.why, `${m.method} is a passthrough with no reason beside it`).toBeTruthy();
      }
    }
  });

  it('no two members claim the same circuit — a second copy under a second name', () => {
    /*
     * **FOUND BY THIS ROUND'S test-coverage pass, AGAINST THIS ROUND'S OWN CHANGE,
     * AND IT IS `C373`'s SHAPE GETTING BACK IN.** A member called `secondLeaf`
     * added to both schemes and declared `{ circuit: 'signerLeaf', kind:
     * 'mirrored' }` passed all three tests above: the mirror assertions iterate
     * `SCHEMES` by CIRCUIT (`:455-466`), so a circuit gets one mirror test no
     * matter how many members claim it, and nothing ever calls `secondLeaf`.
     *
     * `C373`'s copy was a second derivation under a name that was not the
     * circuit's. This is that, one layer in.
     */
    const claimed = SCHEME_MEMBERS.filter(m => m.kind === 'mirrored').map(m => m.circuit);
    expect(
      [...new Set(claimed)].sort(),
      'two scheme members name the same circuit as a mirror. Only one of them can be the '
      + 'client side that this file\'s mirrored entry actually calls; the other is a second '
      + 'copy with nothing checking it, which is C373.',
    ).toEqual([...claimed].sort());
  });

  it('the circuits NO scheme touches are the ones whose notes say so — and only those', () => {
    /*
     * **THIS IS THE ASSERTION THAT MAKES `adoptVaultPayload` AND
     * `retireVaultPayload`'s NOTES TRUE RATHER THAN CLAIMED**, and it is what
     * replaced `S44`'s two `'(checked by grep, S44)'` hand-assertions.
     *
     * Both notes say *no method on either scheme derives this*. That sentence
     * is now READ: the set below is every `contractOnly` circuit that no member
     * of either scheme names. **Write a scheme method for either of them and
     * this set shrinks and this test goes red** — which is the one thing
     * nothing did before, and which the file's header records as having been
     * false three times, twice at `P0`.
     *
     * The other three are here because they are the same fact about the same
     * question, and a list that named only the two would be a list somebody
     * has to remember to extend.
     */
    const named = new Set(SCHEME_MEMBERS.map(m => m.circuit).filter(c => c !== NO_CIRCUIT));
    const untouched = [...contractOnlyCircuits].filter(c => !named.has(c)).sort();
    expect(
      untouched,
      'a circuit registered contractOnly has gained a scheme member, or lost one. If a client '
      + 'copy now exists, turn its registry entry into a mirrored one the way the four '
      + 'governance payloads are — do not write a second derivation. If it is a passthrough '
      + 'that reads the circuit, declare it as one in SCHEME_MEMBERS and say so.',
    ).toEqual([
      'adoptVaultPayload', 'paidMovementOf', 'retireVaultPayload', 'slotOf', 'vacantSlot',
    ]);
  });

  /**
   * **THE FOUR SIMULATED GOVERNANCE PAYLOADS, PINNED TO FIXED HEX.** `S44`,
   * found by its own test-coverage pass against its own change.
   *
   * `S44` moved these four bodies from module scope in `src/core/ledger.ts`
   * behind `SimulatedCommitments`, and wrote down that they are byte-for-byte
   * the ones that stood there — which is a rule-14 truth claim and had no
   * instrument behind it. **NOTHING IN THIS REPOSITORY PINNED THEIR VALUES.**
   * `AccountService` and `SimulatedLedger` both compute them through
   * `this.commitments`, so both sides of every governance check move together:
   * changing `'midnight-accounts:vault-thresh:'` to anything else, or
   * reordering the concatenation at `src/core/ledger.ts:857`, leaves the whole
   * suite green — and every governance `digest` already sealed into a customer's
   * store stops matching at `AccountService.approvedFor`
   * (`src/core/account.ts:2825`), on the two rounds an account uses to recover
   * from a lost signer.
   *
   * Fixed vectors are the only thing that catches it, for the same reason
   * `commitments.test.ts` uses them for `assetKeyOf` and `changeCommitmentOf`:
   * a value compared with a second computation of itself is `C306`.
   */
  /**
   * **THE TWO RUN PAYLOADS MUST NEVER AGREE.** `C375`, `S47` — the same rule
   * `what-a-signer-is.test.ts:253` already pins for `signerPublicKey` and the
   * four governance payloads: a commitment is only ever checked against the
   * scheme that made it, and a simulated value that a chain would accept is a
   * simulation that can sign for the real thing.
   *
   * **AND EVERY ARGUMENT IS CARRIED, ON BOTH SIDES.** `T-116`'s lesson: the
   * mirror above samples ONE tuple, so an adapter that dropped `closesAt` — or
   * a simulated spelling that folded `payees` and `opensAt` into one string
   * without a separator — is green in it. Two runs with one payload is two runs
   * with one id, and the second is refused as already open while the first is
   * paid against a window nobody approved.
   */
  it('the run payload differs between the schemes and carries all four arguments', () => {
    const r = hex(ROOT);
    expect(SimulatedCommitments.runPayload(r, 5n, 1_800_000_000n, 1_800_604_800n))
      .not.toBe(MidnightCommitments.runPayload(r, 5n, 1_800_000_000n, 1_800_604_800n));

    for (const scheme of [MidnightCommitments, SimulatedCommitments]) {
      const base = scheme.runPayload(r, 5n, 1_800_000_000n, 1_800_604_800n);
      expect(scheme.runPayload(hex(LEAF), 5n, 1_800_000_000n, 1_800_604_800n)).not.toBe(base);
      expect(scheme.runPayload(r, 6n, 1_800_000_000n, 1_800_604_800n)).not.toBe(base);
      expect(scheme.runPayload(r, 5n, 1_800_000_001n, 1_800_604_800n)).not.toBe(base);
      expect(scheme.runPayload(r, 5n, 1_800_000_000n, 1_800_604_801n)).not.toBe(base);
    }
  });

  it('the SIMULATED governance payloads are the values they have always been', () => {
    expect(SimulatedCommitments.signerAddPayload(hex(LEAF)))
      .toBe('759b19316051d9d39153b92c0099189367f6ff8ad2db377e67db1a46891bc16d');
    expect(SimulatedCommitments.signerRemovePayload(hex(LEAF)))
      .toBe('2d46fcd7808701be6eba93811b7a829e61111f96e999347d375a6f19433121c4');
    expect(SimulatedCommitments.signerThresholdPayload(3))
      .toBe('cffb8ca4c82c7d95e140142b8947eb56fecca0d575f37fd9af91a5422d212246');
    expect(SimulatedCommitments.vaultThresholdPayload(hex(VAULT), 2))
      .toBe('68d9a947fd55a7555b1e9d773c22a98a12d3625e226d1c6ebc88fc8bf5674d77');
  });

  /**
   * **THE ADAPTERS PASS THE ARGUMENTS THEY ARE GIVEN, NOT A CONSTANT.** `S44`,
   * and the shape is `what-a-signer-is.test.ts:213`'s, which is where this
   * repository already learned that a mirror sampled at ONE value proves the
   * value and not the parameter.
   *
   * The mirrors above call `vaultThresholdPayload` exactly once, at threshold
   * `2` against one vault. An adapter rewritten to ignore either argument —
   * `setVaultThresholdPayload(fromHex(vault), 2n)`, or a hard-coded vault —
   * is green in every mirror in this file. On chain that is one approval
   * spending against a different vault's bar, or against a threshold nobody
   * approved.
   */
  it('the threshold adapters carry BOTH arguments through, not one of them', () => {
    const v = hex(VAULT);
    const other = hex(LEAF);
    expect(MidnightCommitments.vaultThresholdPayload(v, 2))
      .not.toBe(MidnightCommitments.vaultThresholdPayload(v, 3));
    expect(MidnightCommitments.vaultThresholdPayload(v, 2))
      .not.toBe(MidnightCommitments.vaultThresholdPayload(other, 2));
    expect(MidnightCommitments.signerThresholdPayload(2))
      .not.toBe(MidnightCommitments.signerThresholdPayload(3));
    /* And the same of the simulated pair, which has the same two arguments and
     * its own reason to drop one. */
    expect(SimulatedCommitments.vaultThresholdPayload(v, 2))
      .not.toBe(SimulatedCommitments.vaultThresholdPayload(other, 2));
  });

  it('the simulated schemes are NOT the contract\'s, and must never become so', () => {
    /*
     * decision 0004: `core/` runs a different commitment scheme because it
     * cannot import generated Midnight code. That is fine while the two never
     * meet — and catastrophic the moment somebody "unifies" them by making the
     * simulation emit contract values it cannot actually prove.
     *
     * **This one is a tripwire, not a load-bearing check, and it is labelled
     * that way deliberately.** Attempts to mutate it into failing did not
     * succeed: the two schemes use different hash functions entirely, so they
     * cannot collide by a change of domain string, and the mutation that would
     * matter — importing the contract into `core/` — is prevented by the module
     * boundary rather than by this assertion. It is kept because it costs
     * nothing and states the invariant where somebody will read it, and it is
     * described honestly because a test that claims more than it checks is
     * worse than no test.
     */
    expect(SimulatedCommitments.signerAddPayload(hex(LEAF)))
      .not.toBe(hex(pureCircuits.signerAddPayload(LEAF)));
    expect(SimulatedCommitments.signerRemovePayload(hex(LEAF)))
      .not.toBe(hex(pureCircuits.removeSignerPayload(LEAF)));
    /*
     * **THE OTHER TWO, ADDED BY `S44`.** All four governance payloads are on
     * `CommitmentScheme` now, so all four have a simulated implementation that
     * must stay apart from the contract's — and the two added here are the two
     * whose names differ, so this also fails if somebody "unifies" them by
     * pointing the simulated scheme at the wrong circuit.
     */
    expect(SimulatedCommitments.signerThresholdPayload(3))
      .not.toBe(hex(pureCircuits.setThresholdPayload(3n)));
    expect(SimulatedCommitments.vaultThresholdPayload(hex(VAULT), 2))
      .not.toBe(hex(pureCircuits.setVaultThresholdPayload(VAULT, 2n)));
    void fromHex;
  });
});

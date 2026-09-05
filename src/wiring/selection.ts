/**
 * WHICH IMPLEMENTATION OF THE BOUNDARY RUNS. ONE PLACE, AND ALL THREE TOGETHER.
 *
 * `src/core/ledger.ts` declares three interfaces — `Ledger`, `ProofSystem` and
 * `CommitmentScheme`. Until this file existed each was chosen separately, in
 * four files:
 *
 *     src/server/index.ts:101-102    `new SimulatedLedger()`, `new SimulatedProofSystem()`
 *     src/standalone/main.tsx:40-41  the same two again — a second copy of the decision
 *     src/core/account.ts:253        the commitment scheme as a DEFAULT parameter, which
 *                                    the server took by passing only two arguments
 *     src/web/App.tsx:5 and :2125    a module-level import of `SimulatedCommitments`,
 *                                    with no argument anywhere to change it
 *
 * ── THE THREE MAY NEVER BE CHOSEN APART, AND THIS IS NOT TIDINESS ────────
 *
 * `src/core/account.ts` says why, above the default this replaces: *"A leaf
 * computed under the simulated scheme is meaningless to the Compact contract and
 * vice versa."* Swapping the two constructions at the first site and nothing else
 * — the "one line in the wiring" the boundary comment used to promise — would
 * have left the simulated commitment scheme running under a real ledger, and
 * every signer leaf, asset key and balance commitment the product wrote would
 * have been a value the contract cannot read. **That mismatch typechecks, boots,
 * serves pages and says nothing** until a proof is attempted on chain, at which
 * point the leaves already written are unprovable and the money behind them is
 * unspendable by the signers they belong to.
 *
 * So this file offers no way to ask for one of the three. `wiring()` takes no
 * argument, there is no lookup by name, and no individual implementation is
 * exported. Ledger, proof system and commitment scheme come out of one object or
 * they do not come out at all. A mixed set is not discouraged here; it is
 * unsayable.
 *
 * The guard has one hole and it is stated rather than hidden: `core/ledger.ts`
 * still exports the simulated implementations, so a future file could import one
 * directly and bypass this. Closing that would mean moving them out of `core/`,
 * which its own tests import them from. **What stands in for it is the inverse
 * grep** — a search for direct construction or module-level import of a
 * simulated implementation on the product path — and `one-wiring-point.test.ts`
 * beside this file runs that search on every suite run, so the invariant is
 * checked rather than remembered.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────
 *
 * **It does not change what runs.** The selection below is the simulated set,
 * which is what every one of those four sites already chose. This round makes the
 * choice expressible in one place; it does not make a different choice.
 *
 * ── WHY IT IS NOT IN `core/` ─────────────────────────────────────────────
 *
 * Because the second entry names `src/midnight/`, and `core/` importing Midnight
 * is the one dependency rule that keeps the standalone build working
 * (`src/core/ledger.ts`, above `CommitmentScheme`). The selector is the layer
 * that is allowed to know about both sides; `core/` stays the layer that knows
 * about neither.
 *
 * ── WHEN A SECOND ENTRY IS ADDED, FOUR THINGS ARE EASY TO MISS ───────────
 *
 * 1. **THE COMMITMENT SCHEME IS NOT ONE OF THEM, AND THIS ITEM USED TO SAY IT
 *    WAS.** It read: *"There is no Midnight commitment scheme to select yet.
 *    `src/midnight/` provides a `Ledger` and a `ProofSystem` and no
 *    `CommitmentScheme` at all, by grep on 27 Aug. A `midnight` entry cannot be
 *    written until one exists, and that is the honest reason there is one entry
 *    here rather than two."* **All of that is false.**
 *    `src/midnight/commitments.ts:72` exports `MidnightCommitments`, declared
 *    `CommitmentScheme` — annotated, not cast, so the compiler
 *    checks it against the interface — over the contract's generated pure
 *    circuits. It predates this file. The grep that missed it was looking for a
 *    class implementing the interface, and this is an object literal annotated
 *    with it; finding nothing was read as there being nothing.
 *
 *    **So a `midnight` entry is blocked by 2, 3 and 4 below and not by a missing
 *    scheme**, and the value it would carry already exists and is already
 *    typechecked. This matters more than a wrong sentence usually would: it was
 *    THE STATED REASON this file has one entry rather than two, so the reason
 *    was never true.
 * 2. **`MidnightProofSystem` is a shell** whose `prove` and `verify` both throw
 *    (`src/midnight/ledger.ts:1638`, `:1642`), so a `midnight` entry would be
 *    selectable before it is usable.
 * 3. **Neither constructs without configuration.** `MidnightProofSystem` takes a
 *    `MidnightConfig` (`src/midnight/ledger.ts:1632`); `MidnightLedger` takes
 *    that and a fee sponsor and a sealed-state store besides (`:249-252`). An
 *    entry needing configuration reads it inside this file. `wiring()` keeps
 *    taking no argument — or the mixing this file prevents comes straight back
 *    as a config argument threaded through four call sites again.
 * 4. **This module is imported by the browser entry points**, so a static import
 *    of `src/midnight/` here would pull the Midnight SDK's WebAssembly into the
 *    page's module graph — the defect `C149` cost four rounds and
 *    `src/web/no-wasm-in-the-page.test.ts` now guards. An entry that reaches
 *    `src/midnight/` must do so behind a dynamic import, which is also why the
 *    two implementations below are behind factory functions rather than
 *    constructed at module scope.
 */
import {
  SimulatedLedger, SimulatedProofSystem, SimulatedCommitments,
  type Ledger, type ProofSystem, type CommitmentScheme,
} from '../core/ledger.js';

/**
 * One implementation of the boundary, whole.
 *
 * The commitment scheme is a value because it is stateless and both a server and
 * a browser need the same one; the other two are factories because they hold
 * state, and each process gets its own.
 */
export interface Wiring {
  /**
   * What is running, as a word. Read today only by the refusal at the foot of
   * this file. **It is deliberately not wired into `/api/health` or the boot
   * banner**, both of which already print `ledger.describe()` and
   * `proofs.describe()` — two statements from the implementations themselves,
   * which is the better evidence. Naming a third place that says what is running
   * is how the three drift apart.
   */
  readonly name: string;
  readonly commitments: CommitmentScheme;
  createLedger(): Ledger;
  createProofSystem(): ProofSystem;
}

const SIMULATED: Wiring = {
  name: 'simulated',
  commitments: SimulatedCommitments,
  /*
   * **THE LEDGER TAKES ITS SCHEME OFF THIS OBJECT'S OWN FIELD**, not a second
   * mention of the name. `T-209`, `S46`: after `S44` a mismatched pair raises
   * rounds no ledger will execute, and `src/core/ledger.ts:1047-1055` says so in
   * a comment and only in a comment. `one-wiring-point.test.ts` pins this.
   */
  createLedger: () => new SimulatedLedger(SIMULATED.commitments),
  createProofSystem: () => new SimulatedProofSystem(),
};

/**
 * THE SELECTION. This line is the whole of what "changing the wiring" now means.
 *
 * Deliberately a constant and not an environment variable: an environment
 * variable would make the running selection depend on how a process was
 * launched, and a page bundled under one selection talking to a server started
 * under another is the same mismatch this file exists to prevent, one level up.
 * When a second entry exists, how a deployment picks between them is that
 * round's decision to take out loud.
 */
const SELECTED: Wiring = SIMULATED;

/** The chosen set, whole. There is deliberately no `wiring(name)`. */
export function wiring(): Wiring {
  return SELECTED;
}

/* ------------------------------------------------------------------ *
 * the dependency on the simulation that was NOT one of the four
 * ------------------------------------------------------------------ */

/**
 * **A FIFTH DEPENDENCY, FOUND BY THE TYPECHECKER RATHER THAN BY THE GREP.**
 *
 * `/api/public` is the evidence route behind the claim that a public observer
 * learns nothing, and both entry points answered it with `ledger.publicView()`.
 * **`publicView` is not on the `Ledger` interface.** It exists only on
 * `SimulatedLedger` (`src/core/ledger.ts:1299`; the citation here read
 * `:1067-1089` until `S29` and had been wrong since the file moved under it),
 * and the calls typechecked
 * only because both files held the concrete class rather than the boundary type.
 * Routing them through this file turned the dependency into two compile errors,
 * which is the first time anything had said it was there.
 *
 * A search for the NAMES of the simulated implementations could never have found
 * this — the coupling is to a method, and neither call site mentions a simulated
 * anything. It is recorded here because it is the more interesting half of what
 * this round learned: the count of places that choose the simulation and the
 * count of places that DEPEND on it are different numbers.
 *
 * **WHAT IS DELIBERATELY NOT DECIDED HERE.** Whether `publicView` belongs on the
 * boundary — a real ledger would answer it by reading the chain, not from local
 * state, and the shape it should return is a design question — or whether the
 * route should say it cannot be answered. Either is somebody's round. What this
 * function does is stop the question being answered by accident: it refuses
 * loudly instead of serving a partial object, because a privacy-evidence route
 * that quietly shows less than it claims to is worse than one that stops.
 */
export type PublicObserverView = ReturnType<SimulatedLedger['publicView']>;

export function observerView(ledger: Ledger): PublicObserverView {
  /*
   * `instanceof` rather than a cast or a `'publicView' in ledger` probe: this is
   * the one file allowed to know which implementations exist, and a structural
   * probe would also accept some future object that happens to have the name.
   */
  if (ledger instanceof SimulatedLedger) return ledger.publicView();
  throw new Error(
    `the running ledger (${SELECTED.name}) cannot show a public observer view: ` +
      'publicView is not part of the Ledger boundary, and what this route should ' +
      'answer from a real chain has not been decided',
  );
}

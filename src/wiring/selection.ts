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
 * which is what every one of those four sites already chose. This change makes the
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
 * 2. **`MidnightProofSystem` is a shell**, and the citation here was stale AND
 *    wrong about the reason. `prove` and `verify` both throw
 *    (`src/midnight/ledger.ts:2212`, `:2218`) — but `prove` never reaches the
 *    sentence about the proof server it appears to throw. Its circuit table
 *    maps all three circuits to `null` (`:2203-2207`), so every call takes the
 *    line above and throws `no Compact circuit for "..." yet`. **The proof
 *    server line is unreachable, and three descriptions of this class quote it
 *    as if it ran.** The product's own attestation feature is the only caller,
 *    and it is unreachable ahead of this for a separate reason, so a chain
 *    entry is selectable before this is usable and nothing gets worse the day
 *    it is.
 * 3. **Neither constructs without configuration, and the configuration now has
 *    a home.** `MidnightProofSystem` takes a `MidnightConfig`
 *    (`src/midnight/ledger.ts:2210`); `MidnightLedger` takes that, a fee
 *    sponsor, a sealed-state store, an address lookup, a providers thunk and a
 *    compiled contract (`:291-337`). **This item used to say the entry reads
 *    its configuration INSIDE THIS FILE. That is now the one thing it must not
 *    do** — see item 4 — so the facts are resolved by `./deployment.ts`, which
 *    is the single home for the address, the endpoints and the proof server,
 *    and which refuses rather than defaulting any of them. `wiring()` still
 *    takes no argument.
 * 4. **THIS ITEM PRESCRIBED A FIX THAT DOES NOT WORK, AND THE ROUND THAT FIRST
 *    TRIED TO ADD A SECOND ENTRY MEASURED IT.** It said: this module is
 *    imported by the browser entry points, so a static import of
 *    `src/midnight/` would pull the SDK's WebAssembly into the page's module
 *    graph — true, and `src/web/no-wasm-in-the-page.test.ts` guards it — and
 *    then it said **an entry that reaches `src/midnight/` must do so behind a
 *    DYNAMIC import.** It must not, because that does not help.
 *
 *    A production build resolves and parses a dynamically imported module like
 *    any other; the module graph is the same graph. Measured on this
 *    repository's own build, from an entry outside it:
 *
 *        this file, as it stands             22 modules,  0 WebAssembly
 *        an entry importing ./chain.ts       —           25 WebAssembly
 *        the same, behind `await import()`   —           25 WebAssembly
 *
 *    Identical. **A dynamic import changes when the code runs, not whether the
 *    bundler reads it**, and the guard asks the bundler.
 *
 *    **SO THE CHAIN SET IS IN `./chain.ts` AND THIS FILE DOES NOT IMPORT IT, BY
 *    EITHER ROUTE.** That is why the second entry is not named below.
 *
 * ── AND THE THING THAT ACTUALLY BLOCKS THE SECOND ENTRY, WHICH IS NOT ────
 * ── ANY OF THE FOUR ABOVE ───────────────────────────────────────────────
 *
 * **THE COMMITMENT SCHEME IS A VALUE ON THIS INTERFACE, THE PAGE READS IT, AND
 * THE CHAIN'S IMPLEMENTATION OF IT CANNOT BE IN THE PAGE.** Measured the same
 * way: `src/midnight/commitments.ts` alone pulls one WebAssembly module,
 * because it is one line over the contract's generated circuits and that is the
 * whole point of it — the hash is the contract's, restated nowhere.
 *
 * The page is not incidental here. It computes a device's own seat —
 * `signerPublicKey` over a signing secret that must never leave the device, and
 * the leaf built from it. Under the chain scheme that derivation IS the
 * contract's circuit; under the simulated one it is deliberately something
 * else, so the two never agree. **So the page must compute a leaf it cannot
 * compute, and the three rules that meet here cannot all be satisfied:**
 *
 *     the secret never leaves the device      → the page derives the leaf
 *     the leaf must be the contract's         → the derivation is the circuit
 *     the page carries no WebAssembly         → the circuit is not in the page
 *
 * **THIS IS A PRODUCT DECISION AND NOT A WIRING ONE**, which is why the change
 * that found it did not take it: the routes out are to derive the seat
 * somewhere other than the page, or to restate the contract's hash in
 * TypeScript — and this project's standing rule is that nothing restates it,
 * because two definitions of one rule is the most expensive mistake made here.
 * Either is somebody's work, and both change what the product is.
 */
import {
  SimulatedLedger, SimulatedProofSystem, SimulatedCommitments,
  type Ledger, type ProofSystem, type CommitmentScheme,
} from '../core/ledger.js';
import type { WiringName } from '../core/provenance.js';

/**
 * One implementation of the boundary, whole.
 *
 * The commitment scheme is a value because it is stateless and both a server and
 * a browser need the same one; the other two are factories because they hold
 * state, and each process gets its own.
 */
export interface Wiring {
  /**
   * What is running, as a word. Read by the refusal at the foot of this file
   * and by every route that hands a company a list, which asks it in order to
   * say which way round a mixture of ledgers is. **It is deliberately not wired into `/api/health` or the boot
   * banner**, both of which already print `ledger.describe()` and
   * `proofs.describe()` — two statements from the implementations themselves,
   * which is the better evidence. Naming a third place that says what is running
   * is how the three drift apart.
   *
   * **IT IS A CLOSED SET RATHER THAN A STRING, AND THAT IS NEW.** A record now
   * carries the ledger that wrote it, and a marker is only worth reading if the
   * words in it are fixed - a free string invites a fourth spelling of an
   * existing ledger, which a reader would classify as *not known* for ever
   * after. **The value written onto a record is taken from the LEDGER and not
   * from here**, because a record must be marked by the thing that wrote it
   * rather than by whatever was meant to be running; the check beside this file
   * pins the two together so they cannot say different things.
   */
  readonly name: WiringName;
  readonly commitments: CommitmentScheme;
  createLedger(): Ledger;
  createProofSystem(): ProofSystem;
}

const SIMULATED: Wiring = {
  name: 'simulated',
  commitments: SimulatedCommitments,
  /*
   * **THE LEDGER TAKES ITS SCHEME OFF THIS OBJECT'S OWN FIELD**, not a second
   * mention of the name. Since the governance salt landed, a mismatched pair raises
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
 *
 * ── THE DECISION, TAKEN ─────────────────────────────────────────────────
 *
 * **IT STAYS A COMPILE-TIME CONSTANT, AND THE ARGUMENT IS STRONGER NOW THAN
 * WHEN IT WAS A GUESS.** A deployment picks by building; it does not pick by
 * how a process was started. The three reasons, in the order they cost money:
 *
 *   1. **THE PAGE AND THE SERVER MUST AGREE, AND ONLY A BUILD CAN MAKE THEM.**
 *      The page holds a commitment scheme, and a scheme disagreeing with the
 *      one the ledger writes under produces leaves the contract cannot read —
 *      silently, and the money behind them is unspendable by the signers it
 *      belongs to. An environment variable is read by the server after the page
 *      has already been built, which is exactly the window where they can
 *      differ.
 *   2. **THE SELECTION IS NOT A DEPLOYMENT FACT AND THE DEPLOYMENT FACTS ARE
 *      NOT THE SELECTION.** Which network, which contract, which indexer, which
 *      prover — those DO vary per deployment, they are configuration, and
 *      `./deployment.ts` is their one home. WHICH IMPLEMENTATION OF THE
 *      BOUNDARY RUNS is a property of the build. Keeping the two apart is what
 *      stops a wrong environment variable turning a simulation into something
 *      that looks like a chain.
 *   3. **A CONSTANT CANNOT BE WRONG AT THREE IN THE MORNING.** An unset
 *      variable has to mean something, and every available meaning is bad: a
 *      simulation that looks live, or a chain nobody meant to touch.
 *
 * **WHAT THAT COSTS, STATED RATHER THAN DISCOVERED:** running against a
 * different network is a rebuild, not a restart. That is the intended price.
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
 * `:1067-1089` until it was corrected, and had been wrong since the file moved under it),
 * and the calls typechecked
 * only because both files held the concrete class rather than the boundary type.
 * Routing them through this file turned the dependency into two compile errors,
 * which is the first time anything had said it was there.
 *
 * A search for the NAMES of the simulated implementations could never have found
 * this — the coupling is to a method, and neither call site mentions a simulated
 * anything. It is recorded here because it is the more interesting half of what
 * this change learned: the count of places that choose the simulation and the
 * count of places that DEPEND on it are different numbers.
 *
 * **WHAT IS DELIBERATELY NOT DECIDED HERE.** Whether `publicView` belongs on the
 * boundary — a real ledger would answer it by reading the chain, not from local
 * state, and the shape it should return is a design question — or whether the
 * route should say it cannot be answered. Either is somebody's work. What this
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

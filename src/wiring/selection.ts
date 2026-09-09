/**
 * WHICH IMPLEMENTATION OF THE BOUNDARY RUNS. ONE PLACE, AND ALL THREE TOGETHER.
 *
 * `src/core/ledger.ts` declares three interfaces - `Ledger`, `ProofSystem` and
 * `CommitmentScheme`. This file says which implementation of them the product
 * runs, and it says it once.
 *
 * **THE SELECTION IS THE CHAIN.** There is no second entry to pick and no way
 * to ask for one. That is the whole subject of this file now, and the rest of
 * it is the two consequences that fall out of it.
 *
 * ── THE THREE MAY NEVER BE CHOSEN APART, AND THIS IS NOT TIDINESS ────────
 *
 * `src/core/account.ts` says why, above the default it used to carry: *"A leaf
 * computed under one scheme is meaningless to the Compact contract and vice
 * versa."* A ledger running under a commitment scheme that disagrees with it
 * writes signer leaves, asset keys and balance commitments the contract cannot
 * read. **That mismatch typechecks, boots, serves pages and says nothing**
 * until a proof is attempted on chain, at which point the leaves already
 * written are unprovable and the money behind them is unspendable by the
 * signers they belong to.
 *
 * So this file offers no way to ask for one of the three, no lookup by name,
 * and no individual implementation. A mixed set is not discouraged here; it is
 * unsayable.
 *
 * ── WHAT IS IN THIS FILE AND WHAT IS NEXT DOOR, AND WHY IT IS SPLIT ──────
 *
 * **THE PAGE LOADS THIS MODULE.** `src/web/main.tsx` imports it to get the
 * commitment scheme, because a device computes its own seat here - a signing
 * secret that must never leave it, and the leaf built from that secret. Under
 * the chain selection that derivation IS the contract's circuit, so the scheme
 * below is the contract's own.
 *
 * **THE PAGE CANNOT LOAD A LEDGER.** A chain ledger needs a sealed-state store
 * on a filesystem and a set of providers pointed at an indexer, a node and a
 * proof server; the module that builds one reaches `node:fs`, and a browser
 * bundle that resolves `node:fs` does not build. So the ledger and the proof
 * system are assembled in `./product.ts`, which only a process with a
 * filesystem imports, and this file never imports it by either route.
 *
 * **A DYNAMIC IMPORT WOULD NOT HELP AND THAT WAS MEASURED**, on this
 * repository's own build, from an entry outside it:
 *
 *     this file, holding no ledger        22 modules,  0 WebAssembly
 *     an entry importing the chain set    -           25 WebAssembly
 *     the same, behind `await import()`   -           25 WebAssembly
 *
 * Identical. A dynamic import changes when the code runs, not whether the
 * bundler reads it, and the guard asks the bundler.
 *
 * ── SO THE FACTORIES BELOW REFUSE, AND THAT IS THE DESIGN ────────────────
 *
 * A caller that reaches this file and asks for a ledger is a caller that has
 * not resolved a deployment - it has no contract address, no indexer, no node
 * and no proof server, and there is deliberately nowhere else for those to come
 * from. **It gets a sentence naming what is missing rather than a ledger that
 * looks ready.** The alternative is the one thing this file exists to prevent:
 * something that boots, serves and answers about a chain it was never pointed
 * at.
 *
 * ── WHY THERE IS NO SIMULATED SET HERE ANY MORE ──────────────────────────
 *
 * The simulated ledger, proof system and commitment scheme still exist and are
 * still defined in `src/core/ledger.ts`. **They are a test double and nothing
 * the product runs reaches them.** `one-wiring-point.test.ts` beside this file
 * walks the tree on every suite run and turns red if any module outside a test
 * names one, which is the boundary rather than this paragraph.
 *
 * ── WHY THE SELECTION IS A CONSTANT AND NOT AN ENVIRONMENT VARIABLE ──────
 *
 * A deployment picks by building; it does not pick by how a process was
 * started. The page's scheme is fixed at bundle time and a server's is fixed at
 * boot, and an environment variable is read after the page has already been
 * built - which is exactly the window in which the two can differ. **Which
 * network, which contract, which indexer, which prover DO vary per deployment**
 * and they are configuration; `./deployment.ts` is their one home. Which
 * implementation of the boundary runs is a property of the build.
 */
import type { Ledger, ProofSystem, CommitmentScheme } from '../core/ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import type { WiringName } from '../core/provenance.js';

/**
 * One implementation of the boundary, whole.
 *
 * The commitment scheme is a value because it is stateless and both a server
 * and a browser need the same one; the other two are factories because they
 * hold state, and each process gets its own.
 */
export interface Wiring {
  /**
   * What is running, as a word. Read by every route that hands a company a
   * list, which asks it in order to say which way round a mixture of ledgers
   * is. **It is deliberately not wired into `/api/health` or the boot banner**,
   * both of which already print `ledger.describe()` and `proofs.describe()` -
   * two statements from the implementations themselves, which is the better
   * evidence. Naming a third place that says what is running is how the three
   * drift apart.
   *
   * **IT IS A CLOSED SET RATHER THAN A STRING.** A record carries the ledger
   * that wrote it, and a marker is only worth reading if the words in it are
   * fixed - a free string invites a fourth spelling of an existing ledger,
   * which a reader would classify as *not known* for ever after. **The value
   * written onto a record is taken from the LEDGER and not from here**, because
   * a record must be marked by the thing that wrote it rather than by whatever
   * was meant to be running.
   */
  readonly name: WiringName;
  readonly commitments: CommitmentScheme;
  createLedger(): Ledger;
  createProofSystem(): ProofSystem;
}

/**
 * **THE SELECTION. This line is the whole of what "changing the wiring" means.**
 *
 * It is the word a record is checked against before anything is served, and the
 * word `./product.ts` is held to when it assembles the set that can actually
 * reach a chain.
 */
const SELECTED_NAME: WiringName = 'chain';

/**
 * Why a ledger cannot be built from here.
 *
 * **IT NAMES THE STATE AND NOT A FILE TO WRITE**, because the reader of this
 * sentence may be looking at a browser console rather than a terminal, and the
 * four facts below are the same four facts wherever they are missing from.
 */
const NO_DEPLOYMENT =
  'a ledger was asked for from a build that has not resolved a deployment. This product '
  + 'runs against a chain, and reaching one needs four facts with no defaults: the address '
  + 'of the deployed contract, an indexer, a node, and a proof server. A build with no '
  + 'filesystem to read them from - the browser-only build is the one that does this - can '
  + 'render its screens and cannot reach an account, a balance or a round.';

const refuse = (): never => { throw new Error(NO_DEPLOYMENT); };

/**
 * The chosen set, as much of it as a module the page loads is allowed to hold.
 *
 * `commitments` is real here because the page genuinely needs it and can carry
 * it. The two factories are the half that needs a deployment, and they refuse
 * rather than pretending.
 */
const SELECTED: Wiring = {
  name: SELECTED_NAME,
  commitments: MidnightCommitments,
  createLedger: refuse,
  createProofSystem: refuse,
};

/** The chosen set, whole. There is deliberately no `wiring(name)`. */
export function wiring(): Wiring {
  return SELECTED;
}

/* ------------------------------------------------------------------ *
 * the evidence route, and the question it leaves open
 * ------------------------------------------------------------------ */

/**
 * **`/api/public` IS THE EVIDENCE ROUTE BEHIND THE CLAIM THAT A PUBLIC
 * OBSERVER LEARNS NOTHING, AND IT CANNOT BE ANSWERED FROM A CHAIN TODAY.**
 *
 * Both entry points used to answer it with `ledger.publicView()`. That method
 * is not on the `Ledger` boundary - it existed only on the simulated ledger,
 * and the calls typechecked only because both files held the concrete class
 * rather than the boundary type. Routing them through this file turned the
 * dependency into two compile errors, which was the first time anything had
 * said it was there.
 *
 * **WHAT IS DELIBERATELY NOT DECIDED HERE.** Whether a public observer view
 * belongs on the boundary - a chain would answer it by reading the chain, not
 * from local state, and the shape it should return is a design question - or
 * whether the route should say it cannot be answered. Either is somebody's
 * work. What this function does is stop the question being answered by
 * accident: **it refuses in words instead of serving a partial object**,
 * because a privacy-evidence route that quietly shows less than it claims to is
 * worse than one that stops.
 *
 * The refusal reaches a caller as a refused request with this sentence in it,
 * not as an empty answer.
 */
/**
 * **THE SHAPE THIS ROUTE WOULD ANSWER IN, DECLARED SO THE CALL SITES SPREAD IT
 * RATHER THAN IGNORING IT.**
 *
 * Empty today, because nothing is answered today. It is declared rather than
 * left as `never` for one reason and it is not tidiness: with `never` the only
 * way to call this is as a bare statement, and a bare statement's result cannot
 * be spread into a response. **Both routes would then be assembling a reply
 * that no longer contained the observer view at all** - so the day this
 * function gains a real return value, both would go on serving without it, and
 * a privacy-evidence route quietly showing less than it claims to is the exact
 * failure the refusal below exists to prevent.
 *
 * Spread into the response, the value cannot be dropped by accident: it is
 * either refused, or it is in the reply.
 */
export type PublicObserverView = Record<string, never>;

export function observerView(_ledger: Ledger): PublicObserverView {
  throw new Error(
    `the running ledger (${SELECTED_NAME}) cannot show a public observer view: a public `
    + 'view is not part of the Ledger boundary, and what this route should answer by '
    + 'reading a chain has not been decided',
  );
}

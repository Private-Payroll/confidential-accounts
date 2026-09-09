/**
 * **THE ONE SEAM THAT LETS A TEST DRIVE THE SERVER'S ROUTES OVER A DOUBLE, AND
 * THE ONLY THING KEEPING IT OUT OF A SHIPPED BUILD.**
 *
 * ── WHY IT EXISTS, STATED AS THE PROBLEM AND NOT AS A CONVENIENCE ────────
 *
 * The product runs against a chain and cannot write to one: no funded wallet is
 * wired to this deployment, so raising, approving, cancelling, admitting and
 * seating all refuse above the ledger. **That is correct and it is what the
 * product does.**
 *
 * It also means the routes that do those things cannot be exercised by driving
 * the real entry point, and those routes are where approval-signature
 * verification, invitation sealing and payee disclosure live - **the checks
 * most worth having.** A suite that stopped exercising them would be a suite
 * that went quiet about the money path on the day the money path got harder.
 *
 * ── WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT ───────────────────
 *
 * **IT IS NOT A MODE.** There is no name to pass, no environment variable, no
 * configuration and no default. A caller hands over a whole `Wiring` it built
 * itself, or the entry point resolves a deployment; there is no third answer
 * and nothing here can produce an implementation of its own.
 *
 * **NOTHING IN THIS FILE REACHES A SIMULATED IMPLEMENTATION.** It cannot select
 * one, name one or construct one - it holds whatever it was handed. The test
 * that hands one over is the thing that names it, out loud, in its own file,
 * which is what a test double is.
 *
 * ── WHAT STOPS A SHIPPED MODULE USING IT, AND IT IS NOT THIS COMMENT ─────
 *
 * `one-wiring-point.test.ts` walks the `.ts` and `.tsx` files under `src/`,
 * excluding `*.test.ts` and `*.test.tsx`, and refuses any that names
 * `handInWiring`. **That is the same walk that refuses a simulated
 * implementation on the product path**, and this file is its only allowed
 * mention, because this is where the name is defined.
 *
 * So a module in that set that took this seam would turn the suite red on the
 * name alone, before anything it did could matter. **A comment would not; the
 * walk does.**
 *
 * ── AND WHAT THE WALK DOES NOT SEE, STATED RATHER THAN LEFT TO BE FOUND ──
 *
 * The sentence above says `.ts` and `.tsx` under `src/` because that is what it
 * reads, and the honest version of a guard is the one that names its own edges:
 *
 *   - **It does not read outside `src/`.** The product's module graph leaves it
 *     - the compiled contract under `contracts/`, and the identity package.
 *   - **It does not read other extensions.** There are no `.js` or `.mjs` files
 *     under `src/` today, and a loader would happily evaluate one.
 *   - **It reads identifiers and not strings.** The pass that hides prose also
 *     hides `mod['hand' + 'InWiring']`, and a bare `export * from` names nothing
 *     at all.
 *   - **This module is imported by the entry point**, so the setter exists as a
 *     live function in every process. Nothing but the walk keeps it uncalled.
 *
 * **NONE OF THOSE IS A ROUTE SOMEBODY TAKES BY ACCIDENT, WHICH IS WHAT THIS
 * GUARD IS FOR.** A second wall covers the half that matters most: the page's
 * own build asserts, exactly, which WebAssembly modules reach it, so anything
 * dragging a simulated or a chain ledger into the page turns that red whatever
 * route it took.
 */
import type { Wiring } from './selection.js';

let handed: Wiring | null = null;

/**
 * Hand a whole boundary implementation to the entry point, for a test.
 *
 * **CALLED BEFORE THE ENTRY POINT IS IMPORTED, AND THAT IS NOT A STYLE NOTE.**
 * The server builds its store and its services while it is being evaluated, so
 * a set handed over afterwards would arrive after everything that would have
 * used it. A caller that gets the order wrong sees the deployment's own answer
 * rather than its own, which is a test measuring something it did not mean to.
 */
export function handInWiring(w: Wiring): void {
  handed = w;
}

/** What was handed over, or `null` - which is every shipped build. */
export function handedInWiring(): Wiring | null {
  return handed;
}

/*
 * **THERE IS DELIBERATELY NO `forget`, AND THAT IS A STATED GAP RATHER THAN A
 * TIDY-UP.**
 *
 * One stood here: a setter's counterpart, for a runner that loads more than one
 * test file into one process, where a set left behind by a finished file is a
 * set the next one did not ask for. **Nothing called it.** A defence with no
 * caller is a sentence, and this project has paid for those.
 *
 * The hazard is real and is not live: the runner isolates test files, so each
 * gets its own module registry and nothing leaks between them. **The day that
 * isolation is turned off for speed, a set handed over by one file reaches the
 * next file that evaluates the entry point - and the suite would go GREENER,
 * not red**, because the files that hand nothing in would start receiving a
 * double. That is written here so whoever changes the runner meets it.
 */

/**
 * THE SET THE PRODUCT ACTUALLY RUNS, ASSEMBLED WHERE A DEPLOYMENT CAN BE READ.
 *
 * `./selection.ts` says WHICH implementation of the boundary runs and holds the
 * commitment scheme, because the page loads that module and needs the scheme.
 * It cannot hold a ledger: building one reaches a sealed-state store on a
 * filesystem, and a browser bundle that resolves `node:fs` does not build.
 *
 * **SO THIS FILE IS THE OTHER HALF, AND ONLY A PROCESS WITH A FILESYSTEM
 * IMPORTS IT.** It reads the deployment, builds the chain ledger and proof
 * system, and hands back one `Wiring` whose scheme is the SAME OBJECT the page
 * was given.
 *
 * ── THE SCHEME IS TAKEN, NEVER RESTATED, AND IT IS CHECKED ───────────────
 *
 * A second mention of the commitment scheme in this file would be a second
 * answer to the question `./selection.ts` exists to answer once. So the scheme
 * below comes off `wiring()`, and the set built next door is CHECKED against it
 * rather than trusted: if the two ever stop being the same object this refuses
 * to assemble anything. **A ledger writing leaves under one scheme while the
 * page derives seats under another is the failure that is silent all the way to
 * the chain**, and a check that costs one comparison is worth having between
 * two files that can be edited apart.
 *
 * ── WHAT A PROCESS GETS WHEN THERE IS NO CONFIGURATION ───────────────────
 *
 * A refusal it can act on, as a VALUE and not an exception. `startProduct`
 * returns either the set or a sentence; nothing here throws past its caller, so
 * an entry point never has to choose between a stack trace and a silent
 * fallback. **There is no fallback to fall back to** - the simulated set is a
 * test double and no module the product runs reaches it.
 */
import { wiring, type Wiring } from './selection.js';
import { chainWiring } from './chain.js';
import { deployment, type Deployment } from './deployment.js';
import type { Ledger, ProofSystem } from '../core/ledger.js';

/**
 * What starting the product against a chain produced.
 *
 * **A VALUE RATHER THAN A THROW, AND THAT IS THE POINT OF THE FILE.** An entry
 * point that has to catch an exception to find out whether it may serve is an
 * entry point that will one day catch it and carry on.
 */
export type Startup =
  | { readonly started: true; readonly wiring: Wiring; readonly deployment: Deployment }
  | { readonly started: false; readonly refusal: string; readonly wiring: Wiring };

/**
 * **THE HEADING AN OPERATOR READS FIRST.** It is here, as one exported
 * constant, so the sentence a person sees and the sentence a check looks for
 * cannot drift apart.
 */
export const CANNOT_START =
  'this deployment cannot start, and nothing has been served.';

/**
 * **WHAT IS PRINTED WHEN THE FACTS ARE MISSING - AND NOTHING ELSE IS.**
 *
 * Pure, so it can be exercised without a filesystem, a network or a process.
 * It takes whatever was thrown and produces the block a person reads.
 *
 * ── THE THREE RULES IT KEEPS ─────────────────────────────────────────────
 *
 * **NO STACK.** A stack trace is a description of this program's insides
 * offered to somebody trying to configure it. Only the message survives, and
 * only the message: an `Error` carries a `stack` that begins with the message,
 * so taking `.stack` would smuggle the whole thing back in.
 *
 * **THE CAUSE IS QUOTED WHOLE AND NEVER SUMMARISED.** The sentences that can
 * arrive here already name the missing fact and say why it has no default. A
 * layer that rewords them is a layer that will one day reword them wrongly.
 *
 * **AND IT SAYS WHAT STATE FOLLOWED.** Whoever reads this needs to know the
 * process is not up and is not half up, because the failure a silent partial
 * start produces is a screen showing an account that is not there.
 */
export function startupRefusal(thrown: unknown): string {
  const cause = thrown instanceof Error
    ? thrown.message
    : typeof thrown === 'string' ? thrown : String(thrown);
  return `${CANNOT_START}\n\n${cause}\n\n`
    + 'This product runs against a chain and has no other mode to fall back to, so a '
    + 'deployment that cannot say which contract it is talking to is one that must not '
    + 'answer questions about accounts, balances or rounds.';
}

/**
 * **THE TWO HALVES ARE HELD TOGETHER HERE, AND THE RULE IS ITS OWN FUNCTION.**
 *
 * The page was handed the scheme off `./selection.ts`; the ledger writes under
 * whatever the chain module carries. They are the same import today, and this
 * is what notices the day they are not - between two files that can be edited
 * apart, which is the only reason a comparison this cheap is worth making at
 * all.
 *
 * **PURE, SO THE REFUSING BRANCH CAN BE READ WITHOUT ARRANGING A SECOND
 * COMMITMENT SCHEME.** A guard whose failure can only be reached by inventing
 * the very state it exists to prevent is a guard nobody has ever seen fire.
 *
 * Returns the sentence to refuse with, or `null` to proceed.
 */
export function halvesDisagree(
  built: { readonly name: string; readonly commitments: unknown },
  selected: { readonly name: string; readonly commitments: unknown },
): string | null {
  /*
   * **IDENTITY AND NOT EQUIVALENCE.** Two schemes that answer the same today
   * and diverge tomorrow are exactly the second definition this product
   * forbids, and a structural compare would call them the same object.
   */
  if (built.commitments !== selected.commitments) {
    return 'the ledger about to be built computes commitments under a different scheme from '
      + 'the one this build hands to a device for deriving its own seat. A leaf computed '
      + 'under one scheme is meaningless to the contract under the other, and nothing would '
      + 'say so until a proof was attempted on chain - by which point the leaves already '
      + 'written cannot be proved, and the money behind them cannot be spent by the signers '
      + 'it belongs to.';
  }
  if (built.name !== selected.name) {
    return `the ledger about to be built marks its records "${built.name}" and this build is `
      + `selected as "${selected.name}". A record is read back by the word it carries, so two `
      + 'answers here means records nothing can classify afterwards.';
  }
  return null;
}

/**
 * Assemble the running set from a deployment that has already been resolved.
 *
 * Separated from the reading above it for the reason `./deployment.ts` gives
 * about its own rules: everything that can refuse takes plain values, so it can
 * be exercised without arranging a filesystem.
 */
export function assembleFor(
  d: Deployment,
  addressOf: (accountId: string) => Promise<string | null>,
): Wiring {
  const selected = wiring();
  const chain = chainWiring(d, addressOf);

  const disagreement = halvesDisagree(
    { name: chain.name, commitments: chain.commitments },
    selected,
  );
  if (disagreement !== null) throw new Error(disagreement);

  return {
    name: selected.name,
    commitments: selected.commitments,
    createLedger: () => chain.createLedger(),
    createProofSystem: () => chain.createProofSystem(),
  };
}

/* ------------------------------------------------------------------ *
 * what a process holds when there is no deployment to hold
 * ------------------------------------------------------------------ */

/**
 * **A LEDGER THAT ANSWERS NOTHING AND SAYS WHY, RATHER THAN A MODULE THAT
 * WILL NOT LOAD.**
 *
 * ── WHY THIS EXISTS AND IS NOT A THROW AT CONSTRUCTION ───────────────────
 *
 * A process with no deployment has no business serving, and the entry point
 * below refuses to listen. But the module still has to LOAD - it is imported by
 * tooling and by tests that never serve, and a module that throws while it is
 * being evaluated takes the importer down with it and reports a failure about
 * this file rather than about the missing configuration.
 *
 * **AND A REFUSAL PER CALL IS THE STRONGER GUARANTEE, NOT THE WEAKER ONE.**
 * Every question about an account, a balance or a round is refused BY NAME, so
 * there is no path through this object that produces an answer. An empty answer
 * would be the dangerous shape: a company shown no rounds cannot tell that from
 * a company that has none.
 *
 * **IT REJECTS, IT NEVER THROWS SYNCHRONOUSLY**, for the reason the chain
 * ledger gives about its own refusals: a caller that wrote `.catch(...)` on a
 * method that throws before it returns does not catch anything, and a refusal
 * that escapes the caller's error handling is a refusal the product cannot
 * report.
 */
export function unconfiguredLedger(refusal: string, _name: Wiring['name']): Ledger {
  const no = (what: string): Promise<never> =>
    Promise.reject(new Error(`${what} cannot be answered: ${refusal}`));

  return {
    /**
     * **IT REFUSES TO SAY WHAT WROTE A RECORD, BECAUSE IT HAS NOT WRITTEN
     * ONE.**
     *
     * This getter is where a record's marker comes from - `AccountService`
     * reads it and the write paths stamp it on. The selector states the rule
     * it is held to: **the value written onto a record is taken from the
     * LEDGER and not from the selection, because a record must be marked by
     * the thing that wrote it rather than by whatever was meant to be
     * running.**
     *
     * **SO RETURNING THE SELECTED WORD HERE WOULD BE THE EXACT FAILURE THAT
     * RULE EXISTS TO FORBID**: a record stamped `chain` by something that has
     * never reached a chain, which nothing afterwards could ever unpick -
     * *not known* is recoverable and *falsely vouched for* is not.
     *
     * It throws rather than answering, and it throws rather than returning a
     * third word, because the type is a closed set of two and widening it here
     * would put the burden on every reader instead of on the one writer. **A
     * write path that asks this refuses, which is the correct outcome for a
     * ledger that cannot write.**
     */
    get wiring(): never {
      throw new Error(
        'which ledger wrote this record cannot be answered: nothing has been written. '
        + refusal);
    },
    describe: () => 'no ledger: this deployment has not been told which contract to talk to',

    open: () => no('opening an account'),
    address: () => no('the address of an account'),
    status: () => no('the state of an account'),
    paidAmong: () => no('what has been paid among a set of signers'),
    fetch: () => no('a stored record'),
    reseal: () => no('filing an account\'s sealed state'),
    propose: () => no('raising a round'),
    proposeRun: () => no('raising a payroll round'),
    approve: () => no('approving a round'),
    cancel: () => no('cancelling a round'),
    addSigner: () => no('adding a signer'),
    removeSigner: () => no('removing a signer'),
    setThreshold: () => no('changing the approval threshold'),
    setVaultThreshold: () => no('changing a vault\'s approval threshold'),
  } as Ledger;
}

/** The same, for the proof system. Nothing is proved without a proof server. */
export function unconfiguredProofSystem(refusal: string): ProofSystem {
  const no = (what: string): Promise<never> =>
    Promise.reject(new Error(`${what} cannot be done: ${refusal}`));
  return {
    prove: () => no('proving a circuit'),
    verify: () => no('verifying a proof'),
    describe: () => 'no proof system: this deployment has not been told where its proof server is',
  };
}

/**
 * The whole set for a process that could not resolve a deployment.
 *
 * **THE COMMITMENT SCHEME IS STILL THE REAL ONE**, and that is deliberate. It
 * needs no configuration, a device still derives its own seat with it, and
 * handing back a different scheme here would be the one thing this pair of
 * files exists to prevent - two schemes in one product.
 */
export function unconfiguredWiring(refusal: string): Wiring {
  const selected = wiring();
  return {
    name: selected.name,
    commitments: selected.commitments,
    createLedger: () => unconfiguredLedger(refusal, selected.name),
    createProofSystem: () => unconfiguredProofSystem(refusal),
  };
}

/**
 * Read the deployment, assemble the set, and report either.
 *
 * `addressOf` is the one input this module does not own: an account id becomes
 * an address by asking whatever recorded it, and that is the product's store
 * rather than this file's business.
 */
export function startProduct(
  addressOf: (accountId: string) => Promise<string | null>,
  root: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Startup {
  try {
    const d = deployment(root, env);
    return { started: true, wiring: assembleFor(d, addressOf), deployment: d };
  } catch (e) {
    const refusal = startupRefusal(e);
    /*
     * **A SET IS STILL RETURNED, AND EVERY QUESTION IT IS ASKED IS REFUSED.**
     * The caller decides whether to carry on; what it cannot do is carry on and
     * get an answer.
     */
    return { started: false, refusal, wiring: unconfiguredWiring(refusal) };
  }
}

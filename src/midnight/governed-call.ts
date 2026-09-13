/**
 * **WHETHER A GOVERNED CALL IS FIT TO BE BUILT AT ALL, AS ONE RULE THREE
 * DIFFERENT CALL BUILDERS ASK.**
 *
 * A circuit on this account reads its private half through witnesses: the
 * calling device's own secret key, its blinding factor, its scope, and a path
 * through the signer tree. The scheme supplies that half by being told WHERE
 * the record is filed - one string, computed when the call is prepared.
 *
 * **THE FAILURE THIS FILE EXISTS TO MAKE IMPOSSIBLE IS NOT A WRONG KEY. IT IS
 * NO KEY AT ALL, AND IT IS SILENT.** The scheme omits the field entirely on a
 * falsy value and then tests for it by PRESENCE, so a key that does not arrive
 * does not arrive as `undefined` - it selects a different branch, the one for
 * calls that read no private state, and the circuit executes with its private
 * half literally absent. Every witness that answers for a signer then reads off
 * nothing. What a caller sees, if anything, is a dereference from inside the
 * generated contract naming none of this; what the account sees is a call with
 * no signer behind it.
 *
 * So a dropped argument must be a refusal that names itself, and the refusal
 * has to live somewhere every builder reaches.
 *
 * -- WHY THIS IS A FILE AND NOT A CHECK INSIDE ONE METHOD -------------------
 *
 * The check used to sit inside the account client's own call builder, which is
 * one of FOUR things in this repository that turn a circuit and some arguments
 * into a transaction:
 *
 *   the account client's call builder   goes through the find below it
 *   the find itself                     reachable directly, and reached directly
 *   the queued-work runner              assembles the scheme's call options
 *                                       itself, through neither of the others
 *   a measuring door                    builds one unproven call by hand, to
 *                                       watch what a circuit costs
 *
 * A check inside the first protects the first. The second and third were both
 * written after it and neither acquired one, which is the shape of the original
 * defect repeating rather than a new one: **the rule was true, and it was in a
 * place the next caller had no reason to look.**
 *
 * -- THE CLAIM IS CHECKED IN BOTH DIRECTIONS, AND ONLY ONE OF THEM IS LOUD ---
 *
 * `null` is a legitimate answer - some circuits are permissionless by design and
 * read no witness at all - so `null` cannot simply be refused. But `null` on its
 * own is a claim about a circuit, made by the caller, and a caller that makes it
 * wrongly produces exactly the silent failure above with a value that type
 * checks. So the claim is checked against the circuit it is made about:
 *
 *   a circuit that READS a witness, handed `null`   runs against nothing, silently
 *   a circuit that reads NONE, handed a key         wastes a read, and puts the call
 *                                                   on the path where the scheme
 *                                                   writes the record back after
 *                                                   settlement
 *
 * The second is a waste and the first is a loss, and they are both refused here
 * because a rule that holds in one direction is a rule somebody will later read
 * as permission in the other.
 *
 * -- AND THE SET IS AN ARGUMENT RATHER THAN A CONSTANT IN THE RULE -----------
 *
 * Which circuits read no witness is a property of a CONTRACT, and there is more
 * than one contract here. The rule takes the set it is to judge against, so that
 * asking it about a contract it was never given the shape of is a thing the
 * compiler stops rather than a thing it silently answers wrongly.
 */

/**
 * Where a call's private state is filed, or `null` for a circuit that reads no
 * witness. There is no third answer, and `undefined` is a dropped argument.
 */
export type PrivateStateAnswer = string | null;

/**
 * **THE CIRCUITS ON THE ACCOUNT CONTRACT THAT READ NO WITNESS.**
 *
 * Taken from the contract and nowhere else: a circuit is on this list only if
 * it, and everything it calls, reads none of the nine witnesses. None of the
 * three opens with a signer check.
 *
 *   `closeExpiredRun`  the contract leaves it open to anybody on purpose, so
 *                      that a round nobody closed can still be closed by
 *                      whoever notices.
 *   `recordPayment`    entered from the vault across the contract boundary. Its
 *                      salt is an argument rather than a witness, which is what
 *                      lets the vault make it at all.
 *   `retireVault`      reads ledger state and writes ledger state.
 *
 * **AND THE LIST IS THE CONTRACT'S, NOT THE CALL BUILDER'S, WHICH IS A WIDER
 * THING THAN IT USED TO BE.** While this was consulted only by the account
 * client's own call builder it could stop at the circuits that builder drives,
 * because no other name could reach it. It is now also asked at the call
 * interface, and an interface carries every circuit the contract has - so a
 * circuit missing from a list scoped to the driven ones would be judged by a
 * rule nobody wrote about it, in both directions: handed a key it does not
 * read without complaint, and refused when handed `null` with a sentence
 * claiming a signer check it does not open with.
 */
export const CIRCUITS_THAT_READ_NO_WITNESS: ReadonlySet<string> =
  new Set(['closeExpiredRun', 'recordPayment', 'retireVault']);

/**
 * Why this call may not be built, or `null` when it may.
 *
 * A sentence rather than a thrown error, so that a caller which has somewhere
 * better to put the reason than an exception can have it. The throwing form is
 * below and is the one almost everything uses.
 */
export const whyThisCallCannotBeBuilt = (
  circuit: string,
  privateStateId: PrivateStateAnswer | undefined,
  circuitsThatReadNoWitness: ReadonlySet<string>,
): string | null => {
  /*
   * `undefined` is a dropped argument and an empty string is a dropped argument
   * that got as far as a variable. The scheme treats both exactly as it treats
   * a call that was never given a key, by omitting the field. The key this
   * product computes always carries a separator and so can never be empty; the
   * check is here anyway, because the promise this rule makes is about a
   * dropped argument rather than about one particular way of dropping one.
   */
  if (privateStateId === undefined || privateStateId === '') {
    return `the "${circuit}" call was built without saying where its private state is filed. ` +
      'Pass the key the call was prepared with, or null for a circuit that reads no ' +
      'witness. Passing nothing runs the circuit against no private state at all.';
  }
  /*
   * The set is an argument, so it is a thing a caller can drop - and dropping it
   * in a file whose whole subject is dropped arguments would raise a
   * `TypeError` about `has` and name none of this.
   */
  if (circuitsThatReadNoWitness === undefined || circuitsThatReadNoWitness === null) {
    return `the "${circuit}" call could not be judged: nothing said which of this contract's ` +
      'circuits read no witness. That list belongs to the contract being called, and without ' +
      'it there is no answer to give rather than a permissive one.';
  }
  const readsNoWitness = circuitsThatReadNoWitness.has(circuit);
  if (privateStateId === null && !readsNoWitness) {
    return `the "${circuit}" call was built as though it reads no private state, and it reads ` +
      'one. A circuit that opens with a signer check cannot run without the calling ' +
      "device's own record; pass the key the call was prepared with.";
  }
  if (privateStateId !== null && readsNoWitness) {
    return `the "${circuit}" call was given a private state key and reads no witness at all. ` +
      'Pass null: asking for a record it will not read makes a device that holds none ' +
      'unable to make a call the contract deliberately leaves open to anybody.';
  }
  return null;
};

/** The same rule, as a refusal. */
export const refuseACallWithoutItsPrivateState = (
  circuit: string,
  privateStateId: PrivateStateAnswer | undefined,
  circuitsThatReadNoWitness: ReadonlySet<string>,
): void => {
  const why = whyThisCallCannotBeBuilt(circuit, privateStateId, circuitsThatReadNoWitness);
  if (why !== null) throw new Error(why);
};

/**
 * **THE SAME RULE, PUT ON THE CALL INTERFACE ITSELF, WHICH IS THE HALF THAT
 * REACHES CALLERS NOBODY HAS WRITTEN YET.**
 *
 * A find hands back an object whose keys are circuit names and whose values
 * build and submit a call. It is handed a private-state answer once, for all of
 * them, and it cannot know at that moment which circuit anybody will call - so
 * it cannot apply the rule when it is built. **What it can do is make the
 * interface carry the answer it was given, and ask the rule at the moment a
 * circuit is named.**
 *
 * That is what stops the next builder being written wrong. A caller that reaches
 * a find directly, around the client and around the queue, gets an interface
 * that refuses by name rather than one that runs a signer check against nothing.
 *
 * Everything that is not a circuit to call passes through untouched: this wraps
 * the calls, it does not stand in front of the object.
 *
 * **AND THE REFUSAL IS A REJECTION RATHER THAN A THROW, WHICH IS NOT A
 * STYLISTIC CHOICE.** Every member of a call interface returns a promise, so a
 * guard that threw before the promise existed would give one function two
 * failure shapes - caught by a caller that awaits, missed by a caller that
 * chains. A guard whose failure a caller can miss is worse than the defect it
 * is standing in for, because it reads as having been handled.
 */
export const aCallInterfaceThatRefuses = <T extends object>(
  callTx: T,
  privateStateId: PrivateStateAnswer,
  circuitsThatReadNoWitness: ReadonlySet<string>,
  circuitsTheInterfaceCarries: ReadonlySet<string>,
): T => {
  /*
   * **ONLY THE CIRCUITS, AND THE LIST OF THOSE IS AN ARGUMENT RATHER THAN
   * SOMETHING READ OFF THE OBJECT. THE REASON IS NOT TIDINESS.**
   *
   * Two things have to be kept apart here, and both of them bite.
   *
   * A wrapper that judged every FUNCTION it was asked for would judge
   * `toString`, `valueOf` and `hasOwnProperty`, which are functions with string
   * names reached through the prototype. A refusal there is not a refused call:
   * it is a template literal or a `String()` throwing where nobody has a `try`
   * around it, and on an interface built with no key it is a rejected promise
   * nobody is awaiting, which ends the process. A guard that can kill a door
   * between a submission and the line recording what was submitted is worse
   * than the silence it replaced.
   *
   * **AND A WRAPPER THAT TOLD THE TWO APART BY ASKING WHICH PROPERTIES THE
   * OBJECT OWNS WOULD BE SWITCHED ON BY SOMEBODY ELSE'S IMPLEMENTATION
   * DETAIL.** The scheme builds its call interface by accumulating own data
   * properties today; built from a class, a prototype or a getter instead,
   * every lookup would return the unguarded function and nothing anywhere
   * would go red. **A guard that can be switched off silently by a dependency
   * changing shape is the defect it was written to stop, wearing the fix.**
   *
   * So the names are passed in. The caller knows which circuits the deployment
   * has; this file does not have to guess from the furniture.
   */
  const isACircuit = (property: string | symbol): property is string =>
    typeof property === 'string' && circuitsTheInterfaceCarries.has(property);

  const guarded = (property: string, value: (...a: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      refuseACallWithoutItsPrivateState(property, privateStateId, circuitsThatReadNoWitness);
      return value.apply(callTx, args);
    };

  return new Proxy(callTx, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!isACircuit(property)) return value;
      return guarded(property, value as (...a: unknown[]) => unknown);
    },
    /*
     * AND THROUGH THE DESCRIPTOR TOO. Reading a property's descriptor and
     * calling its value is a second way to the same function, and a guard with
     * a way around it is a guard whose next reader is entitled to use it.
     */
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (descriptor === undefined || !isACircuit(property)) return descriptor;
      /*
       * A DATA DESCRIPTOR, AND A CONFIGURABLE ONE, OR IT IS HANDED BACK AS IT
       * IS. Spreading a value onto an accessor descriptor builds a descriptor
       * that is invalid on its face, and reporting a different value for a
       * property that cannot be reconfigured breaks a rule the language
       * enforces with a throw. Either failure arrives naming a proxy, which is
       * a sentence about this file and not about the call anybody was making.
       */
      if (typeof descriptor.value !== 'function' || descriptor.configurable !== true) {
        return descriptor;
      }
      return {
        ...descriptor,
        value: guarded(property, descriptor.value as (...a: unknown[]) => unknown),
      };
    },
  });
};

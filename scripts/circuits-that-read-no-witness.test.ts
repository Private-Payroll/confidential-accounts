/**
 * **THE LIST OF CIRCUITS THAT NEED NO PRIVATE STATE IS DERIVED FROM THE
 * COMPILED CONTRACT, NOT AGREED WITH A SECOND COPY OF ITSELF.**
 *
 * -- WHAT THE LIST DOES ----------------------------------------------------
 *
 * Every governed call this client builds is checked in both directions before
 * it is assembled: a circuit that reads a witness must be given the calling
 * device's private-state key, and a circuit that reads none must be given
 * `null`. The set of circuits that read none is what both checks are made
 * against.
 *
 * -- HOW IT GOES WRONG, AND ONE OF THE TWO WAYS IS SILENT ------------------
 *
 * A circuit that GAINS a witness while still on the list runs against no
 * private state, and fails inside the runtime with an error that names none of
 * this. Loud, and unpleasant, and survivable.
 *
 * A circuit that LOSES its last witness, or a new step for a circuit that
 * already reads none, is handed a key it does not read. **That succeeds.** It
 * also puts the call on the path where the SDK writes the calling device's
 * record back after settlement, for a call that changed nothing in it. Nothing
 * refuses it, nothing tests it, and the type checker is content.
 *
 * -- SO THE LIST IS COMPUTED FROM THE ARTEFACT -----------------------------
 *
 * The artefact reader already reports, for every circuit, which witnesses it
 * reads - through its helpers as well as directly, which matters here because
 * not one governed circuit reads a signer witness itself: all three are read
 * inside the helper seven circuits call. **A direct-only reading of the
 * contract would report that almost nothing reads a witness and would agree
 * enthusiastically with an empty list.**
 *
 * What is asserted is the artefact-derived set, narrowed to the circuits a CALL
 * INTERFACE CARRIES, against the set the client checks with. Neither side is
 * written out here.
 *
 * **AND THE NARROWING USED TO BE TO THE CIRCUITS THIS CLIENT DRIVES, WHICH WAS
 * RIGHT WHILE THE SET WAS ONLY EVER CONSULTED BY THE CALL BUILDER.** The set is
 * now also asked at the call interface, and an interface carries every circuit
 * the contract deploys - so a comparison scoped to the driven ones would leave
 * the circuits nobody drives judged by a rule that was never written about
 * them, with nothing here able to see it.
 */
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import { ARTIFACTS, readContract } from './artifact-scan.js';
import { CIRCUITS_THAT_READ_NO_WITNESS, CIRCUIT_FOR_STEP } from '../src/midnight/ledger.js';
import { DEPLOYED_CIRCUITS } from '../src/midnight/deferral.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The comparison, as a function, so the negative controls below can feed it
 * each of its three inputs in a broken state and watch it report.
 *
 * Returns the two directions separately, because they are different failures
 * and a single boolean would hide which one happened.
 */
export const disagreement = (
  readsNoWitness: readonly string[],
  circuitsDriven: readonly string[],
  declaredAsReadingNone: ReadonlySet<string>,
): { treatedAsNeedingState: string[]; treatedAsNeedingNone: string[] } => {
  const derived = new Set(readsNoWitness.filter((name) => circuitsDriven.includes(name)));
  return {
    /* Reads nothing, and this client hands it a key anyway. The silent one. */
    treatedAsNeedingState: [...derived].filter((name) => !declaredAsReadingNone.has(name)).sort(),
    /* Reads something, and this client hands it nothing. The loud one. */
    treatedAsNeedingNone: [...declaredAsReadingNone].filter((name) => !derived.has(name)).sort(),
  };
};

describe('the circuits that read no witness', () => {
  const account = () => readContract(ROOT, ARTIFACTS[0]);
  const driven = () => [...new Set(Object.values(CIRCUIT_FOR_STEP))];
  /*
   * WHAT THE RULE IS ASKED ABOUT: every circuit a call interface carries, which
   * is every circuit the deployment has - not the subset this client's own call
   * builder can reach.
   */
  const judged = () => [...DEPLOYED_CIRCUITS];

  it('is DERIVED from the compiled contract and agrees with the set the client checks with',
    async () => {
      const model = await account();
      const readsNone = model.circuits.filter((c) => c.witnesses.length === 0).map((c) => c.name);

      expect(disagreement(readsNone, judged(), CIRCUITS_THAT_READ_NO_WITNESS),
        'the contract and the set this client checks calls against no longer agree. A circuit '
        + 'under "treatedAsNeedingState" reads nothing and is being handed the calling device\'s '
        + 'record anyway, which succeeds and then has that record written back after the call '
        + 'settles; one under "treatedAsNeedingNone" reads a witness and is being handed nothing, '
        + 'which runs it against no private state at all')
        .toEqual({ treatedAsNeedingState: [], treatedAsNeedingNone: [] });
    });

  /**
   * **THE DERIVATION HAS TO HAVE FOUND SOMETHING.** Without this, the case
   * above is also satisfied by a reader that reports every circuit as reading
   * no witness, by one that reports none at all, and by an empty artefact.
   */
  it('the artefact reader actually distinguishes the two, measured on this contract', async () => {
    const model = await account();
    const readsNone = model.circuits.filter((c) => c.witnesses.length === 0).map((c) => c.name).sort();
    const readsSome = model.circuits.filter((c) => c.witnesses.length > 0).map((c) => c.name).sort();

    expect(readsNone.length, 'no circuit on this contract reads no witness, which cannot be true '
      + 'while the sweep exists').toBeGreaterThan(0);
    expect(readsSome.length, 'no circuit on this contract reads any witness, so the reader is not '
      + 'seeing through the helper the signer checks live in').toBeGreaterThan(0);
    expect(readsSome, 'the two calls this whole product rests on stopped reading a signer witness')
      .toEqual(expect.arrayContaining(['approve', 'propose']));
  });

  /**
   * **EVERY CIRCUIT THE STEP TABLE NAMES IS ONE THE CONTRACT HAS.** The table
   * is what the private-state answer is computed from, so a name in it that the
   * contract does not declare would be a step whose answer was computed about
   * nothing.
   */
  it('every circuit a prepared step names exists on the contract', async () => {
    const model = await account();
    const declared = new Set(model.circuits.map((c) => c.name));

    expect(driven().filter((name) => !declared.has(name)),
      'a prepared step names a circuit this contract does not declare').toEqual([]);
  });

  /**
   * **THE PAIRING IS PINNED BY VALUE, NOT ONLY BY KEY, AND THAT IS NOT A
   * SECOND HAND-WRITTEN LIST OF THE KIND THIS FILE EXISTS TO REPLACE.**
   *
   * The no-witness set can be derived, because the compiled contract knows
   * which circuits read a witness. **Nothing anywhere knows which STEP calls
   * which circuit** - that pairing is this client's own decision and exists in
   * no artefact - so the only way it can be wrong-and-caught is for it to be
   * written down twice, in two places that have to be changed together.
   *
   * What it catches: an entry repointed at a circuit that exists, takes the
   * same number of arguments and reads a witness. The existence check below
   * passes it, the arity check downstream passes it, the no-witness comparison
   * above passes it, and the type checker passes it, because the value type is
   * a bare string. What arrives on chain is a different operation than the one
   * the person asked for, after a proof.
   */
  it('pairs every prepared step with the circuit it calls, by value', () => {
    expect(CIRCUIT_FOR_STEP,
      'a prepared step now calls a different circuit. If that is deliberate, the contract is '
      + 'what decides whether it is right - change this line last, not first')
      .toEqual({
        propose: 'propose',
        proposeRun: 'propose',
        approve: 'approve',
        cancel: 'cancel',
        addSigner: 'amendSigner',
        removeSigner: 'amendSigner',
        setThreshold: 'setThreshold',
        setVaultThreshold: 'setVaultThreshold',
        closeExpiredRun: 'closeExpiredRun',
      });
  });

  /* ---------------- the negative controls ---------------- */

  /**
   * **THE SILENT DIRECTION, WATCHED.** A step added for a circuit that already
   * reads no witness is the failure this whole row is about: it is handed a key
   * it does not read, it succeeds, and it lands on the write-back.
   *
   * Both of the circuits named here are real ones on this contract that read no
   * witness today, which is why they are the example.
   */
  it.each(['recordPayment', 'retireVault', 'closeExpiredRun'])(
    'reports it when %s falls off the client\'s set while still reading nothing',
    async (dropped) => {
      const model = await account();
      const readsNone = model.circuits.filter((c) => c.witnesses.length === 0).map((c) => c.name);

      expect(readsNone, `${dropped} no longer reads no witness, so this control is about the wrong `
        + 'circuit').toContain(dropped);

      const narrowed = new Set([...CIRCUITS_THAT_READ_NO_WITNESS].filter((n) => n !== dropped));
      expect(disagreement(readsNone, judged(), narrowed))
        .toEqual({ treatedAsNeedingState: [dropped], treatedAsNeedingNone: [] });
    },
  );

  /**
   * **AND THE SCOPE ITSELF, WATCHED.** This is the case that was missing while
   * the comparison narrowed to the driven circuits: two of the contract's
   * circuits are outside that narrowing, so a set that forgot them agreed with
   * the contract anyway. Narrowed to `driven()` this returns nothing; widened
   * to what an interface carries it reports both.
   */
  it('a comparison scoped to the driven circuits cannot see the two nobody drives', async () => {
    const model = await account();
    const readsNone = model.circuits.filter((c) => c.witnesses.length === 0).map((c) => c.name);
    const asItWasBefore = new Set(['closeExpiredRun']);

    expect(disagreement(readsNone, driven(), asItWasBefore))
      .toEqual({ treatedAsNeedingState: [], treatedAsNeedingNone: [] });
    expect(disagreement(readsNone, judged(), asItWasBefore))
      .toEqual({ treatedAsNeedingState: ['recordPayment', 'retireVault'], treatedAsNeedingNone: [] });
  });

  /** **THE LOUD DIRECTION, WATCHED.** A circuit that reads a witness on the list. */
  it('reports it when a circuit that reads a witness is listed as reading none', async () => {
    const model = await account();
    const readsNone = model.circuits.filter((c) => c.witnesses.length === 0).map((c) => c.name);

    expect(disagreement(readsNone, judged(), new Set([...CIRCUITS_THAT_READ_NO_WITNESS, 'approve'])))
      .toEqual({ treatedAsNeedingState: [], treatedAsNeedingNone: ['approve'] });
  });

  /** And an EMPTY list, with every circuit that reads nothing reported. */
  it('reports every one of them when the list is emptied', async () => {
    const model = await account();
    const readsNone = model.circuits.filter((c) => c.witnesses.length === 0).map((c) => c.name);

    expect(disagreement(readsNone, judged(), new Set()))
      .toEqual({
        treatedAsNeedingState: ['closeExpiredRun', 'recordPayment', 'retireVault'],
        treatedAsNeedingNone: [],
      });
  });

  /**
   * **AND THE OTHER WAY THE DERIVATION ROTS: A CIRCUIT GAINS A WITNESS.** The
   * artefact half is what moves here, so it is the artefact half that is
   * mutated - the set and the table are left exactly as the product has them.
   */
  it('reports it when the sweep gains a witness and the list has not caught up', async () => {
    const model = await account();
    const readsNone = model.circuits
      .filter((c) => c.witnesses.length === 0 && c.name !== 'closeExpiredRun')
      .map((c) => c.name);

    expect(disagreement(readsNone, judged(), CIRCUITS_THAT_READ_NO_WITNESS))
      .toEqual({ treatedAsNeedingState: [], treatedAsNeedingNone: ['closeExpiredRun'] });
  });
});

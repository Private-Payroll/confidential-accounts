/**
 * **THE RULE THAT SAYS A GOVERNED CALL MAY NOT BE BUILT WITHOUT ITS PRIVATE
 * STATE, AND THE THREE PLACES IT IS NOW ASKED.**
 *
 * WHAT THIS FILE IS DEFENDING. A circuit that reads a witness and is handed no
 * private-state key does not fail. It runs, it proves, it costs what a proof
 * costs, and the signer check inside it reads off nothing - so the account
 * records a call that no signer made. The scheme makes this possible by
 * omitting the field on a falsy value and then testing for it by presence: the
 * absent key is not `undefined` arriving at a circuit, it is a different branch
 * being taken before the circuit starts.
 *
 * The rule itself was already written and was already asked in one of the three
 * places. **These cases are about the other two**, and about the rule being one
 * thing rather than three copies that can drift.
 *
 * HOW TO READ THE ASSERTIONS. Each one names the change to the product that
 * turns it red, and each of those changes was made to a copy of this tree
 * outside it and watched.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CIRCUITS_THAT_READ_NO_WITNESS,
  whyThisCallCannotBeBuilt,
  refuseACallWithoutItsPrivateState,
  aCallInterfaceThatRefuses,
} from './governed-call.js';

/** A circuit that opens with a signer check, and one the contract leaves open. */
const READS_A_WITNESS = 'propose';
const READS_NONE = 'closeExpiredRun';

/**
 * The names a call interface for this deployment carries.
 *
 * **PASSED IN RATHER THAN READ OFF THE OBJECT, WHICH IS THE POINT.** A guard
 * that worked out which properties were circuits by asking the object would be
 * switched on by how the scheme happened to build it, and would switch off
 * without a word the day that changed.
 */
const CIRCUITS_CARRIED: ReadonlySet<string> = new Set([READS_A_WITNESS, READS_NONE]);

describe('the rule itself, in both directions', () => {
  /*
   * RED WHEN: the presence check at the top of `whyThisCallCannotBeBuilt` is
   * removed, or narrowed to `undefined` alone. Watched: with `|| privateStateId
   * === ''` deleted, the empty-string case below returns null and this fails.
   */
  it('refuses a dropped argument, however it was dropped', () => {
    for (const dropped of [undefined, '']) {
      expect(whyThisCallCannotBeBuilt(READS_A_WITNESS, dropped, CIRCUITS_THAT_READ_NO_WITNESS))
        .toMatch(/without saying where its private state is filed/);
    }
  });

  /*
   * RED WHEN: the `null` branch stops consulting the circuit - if
   * `privateStateId === null` returns null unconditionally, this case passes a
   * circuit that reads a witness and gets no refusal.
   */
  it('refuses null on a circuit that reads a witness', () => {
    expect(whyThisCallCannotBeBuilt(READS_A_WITNESS, null, CIRCUITS_THAT_READ_NO_WITNESS))
      .toMatch(/built as though it reads no private state, and it reads/);
  });

  /*
   * RED WHEN: the second direction is dropped as harmless. It is the direction
   * that is merely wasteful rather than a loss, which is exactly why it is the
   * one a later reader removes.
   */
  it('refuses a key on a circuit that reads none', () => {
    expect(whyThisCallCannotBeBuilt(READS_NONE, 'a-key:acct', CIRCUITS_THAT_READ_NO_WITNESS))
      .toMatch(/given a private state key and reads no witness at all/);
  });

  /*
   * THE CONTROL FOR ALL THREE ABOVE. RED WHEN: the rule starts refusing
   * something it should allow - which is how a guard gets deleted rather than
   * fixed. Without this, a rule that returned a sentence for every input would
   * satisfy every case above.
   */
  it('allows the two sound pairs, and returns no sentence for either', () => {
    expect(whyThisCallCannotBeBuilt(READS_A_WITNESS, 'a-key:acct', CIRCUITS_THAT_READ_NO_WITNESS))
      .toBeNull();
    expect(whyThisCallCannotBeBuilt(READS_NONE, null, CIRCUITS_THAT_READ_NO_WITNESS)).toBeNull();
  });

  /*
   * RED WHEN: the set stops being an argument and becomes a constant inside the
   * rule. The rule would then answer about the account's contract whatever
   * contract it was asked about, and this case - which describes a contract
   * where `propose` needs nothing - would get a refusal.
   */
  it('judges against the set it is given, not against one it holds', () => {
    const anotherContract: ReadonlySet<string> = new Set([READS_A_WITNESS]);
    expect(whyThisCallCannotBeBuilt(READS_A_WITNESS, null, anotherContract)).toBeNull();
    expect(whyThisCallCannotBeBuilt(READS_NONE, null, anotherContract))
      .toMatch(/built as though it reads no private state/);
  });

  /* RED WHEN: the throwing form stops throwing, or throws on a sound pair. */
  it('the refusing form throws exactly when the sentence is not null', () => {
    expect(() => refuseACallWithoutItsPrivateState(
      READS_A_WITNESS, null, CIRCUITS_THAT_READ_NO_WITNESS)).toThrow(/reads no private state/);
    expect(() => refuseACallWithoutItsPrivateState(
      READS_A_WITNESS, 'a-key:acct', CIRCUITS_THAT_READ_NO_WITNESS)).not.toThrow();
  });
});

describe('the call interface carries the answer, so naming a circuit is when it is judged', () => {
  const interfaceOver = (privateStateId: string | null) => {
    const called: string[] = [];
    /* What this stand-in interface declares. `notACircuit` is deliberately not in it. */
    const raw = {
      [READS_A_WITNESS]: async (...args: unknown[]) => { called.push(`propose:${args.length}`); return 'TX'; },
      [READS_NONE]: async () => { called.push('closeExpiredRun'); return 'TX'; },
      notACircuit: 42,
    };
    return {
      called,
      callTx: aCallInterfaceThatRefuses(
        raw, privateStateId, CIRCUITS_THAT_READ_NO_WITNESS, CIRCUITS_CARRIED),
    };
  };

  /*
   * **THE ONE THAT MATTERS, AND THE REASON THIS WRAPPER EXISTS.** A caller that
   * reaches the find directly gets an interface, not a call builder - so
   * without this the whole interface is usable and every circuit on it runs
   * against nothing.
   *
   * RED WHEN: `aCallInterfaceThatRefuses` returns its argument unchanged, or
   * the find stops wrapping. Watched: returning `callTx` directly from the
   * wrapper leaves `called` holding `propose:1` and no throw.
   */
  it('refuses a witness-reading circuit on an interface built with no key', async () => {
    const i = interfaceOver(null);
    await expect(i.callTx[READS_A_WITNESS](1)).rejects
      .toThrow(/built as though it reads no private state/);
    expect(i.called).toEqual([]);
  });

  /* RED WHEN: the second direction is dropped from the wrapper only. */
  it('refuses a no-witness circuit on an interface built with a key', async () => {
    const i = interfaceOver('a-key:acct');
    await expect(i.callTx[READS_NONE]()).rejects.toThrow(/reads no witness at all/);
    expect(i.called).toEqual([]);
  });

  /*
   * THE CONTROL. RED WHEN: the wrapper refuses everything - which every case
   * above would still pass. It also pins that the arguments reach the circuit
   * and that the answer comes back, because a wrapper that dropped either would
   * be a silent change to every call in the product.
   */
  it('lets a sound pair through, with its arguments and its answer', async () => {
    const i = interfaceOver('a-key:acct');
    await expect(i.callTx[READS_A_WITNESS](1, 2)).resolves.toBe('TX');
    expect(i.called).toEqual(['propose:2']);
    const j = interfaceOver(null);
    await expect(j.callTx[READS_NONE]()).resolves.toBe('TX');
    expect(j.called).toEqual(['closeExpiredRun']);
  });

  /*
   * RED WHEN: the wrapper stands in front of the whole object rather than in
   * front of its calls. The interface carries things that are not circuits, and
   * a guard that refused those would break reads that have nothing to do with
   * private state.
   */
  it('passes through what is not a call', () => {
    expect((interfaceOver(null).callTx as any).notACircuit).toBe(42);
    expect((interfaceOver(null).callTx as any).neverDefined).toBeUndefined();
  });

  /*
   * **THE CASE ABOVE IS NOT ENOUGH, AND THE ONE IT MISSES IS THE DANGEROUS
   * ONE.** A NON-FUNCTION passing through says nothing about a FUNCTION that is
   * not a circuit - and every object has several, through its prototype.
   * `toString` is a function with a string name, so a wrapper that judged every
   * function it was asked for would refuse it.
   *
   * That is not a refused call. It is a template literal throwing where nobody
   * has a `try` around it, and on an interface built with no key it is a
   * rejected promise nobody is awaiting, which ends the process. A guard that
   * can kill a door between a submission and the line recording what was
   * submitted is worse than the silence it replaced.
   *
   * RED WHEN: the wrapper judges any function rather than the interface's own -
   * if `isACircuit` drops its `hasOwnProperty` clause. Watched: it then throws
   * "Cannot convert object to primitive value" on the first line here.
   */
  it('leaves the methods every object has alone, so it can still be printed', () => {
    const withKey = interfaceOver('a-key:acct').callTx as any;
    const withNone = interfaceOver(null).callTx as any;
    expect(() => `${String(withKey)}`).not.toThrow();
    expect(() => `${String(withNone)}`).not.toThrow();
    expect(withNone.hasOwnProperty(READS_A_WITNESS)).toBe(true);
    expect(Object.keys(withNone)).toContain(READS_A_WITNESS);
  });

  /*
   * **AND THE GUARD DOES NOT ASK THE OBJECT WHICH OF ITS PROPERTIES ARE
   * CIRCUITS.** An interface whose circuits are reached through a PROTOTYPE
   * rather than owned outright is still guarded, and a name the interface does
   * not declare is still let through.
   *
   * RED WHEN: `isACircuit` goes back to asking the object - `hasOwnProperty`,
   * `typeof value === 'function'`, or anything else read off the furniture.
   * The guard then disappears on the first interface built any other way, and
   * nothing else here would notice.
   */
  it('guards by the names it was given, whatever shape the interface has', async () => {
    const onAPrototype = Object.create({
      [READS_A_WITNESS]: async () => 'TX',
      alsoOnThePrototype: () => 'NOT A CIRCUIT',
    });
    const callTx = aCallInterfaceThatRefuses(
      onAPrototype, null, CIRCUITS_THAT_READ_NO_WITNESS, CIRCUITS_CARRIED);
    await expect((callTx as any)[READS_A_WITNESS]()).rejects
      .toThrow(/built as though it reads no private state/);
    expect((callTx as any).alsoOnThePrototype()).toBe('NOT A CIRCUIT');
  });

  /*
   * **AND THE SECOND ROUTE TO THE SAME FUNCTION.** A descriptor's `value` is
   * the function itself, so a guard that only wrapped property reads would have
   * a way around it - and a guard with a way around it is one its next reader
   * is entitled to use.
   *
   * RED WHEN: the `getOwnPropertyDescriptor` trap is removed.
   */
  it('refuses through the descriptor as well as through the property', async () => {
    const withNone = interfaceOver(null).callTx as any;
    const d = Object.getOwnPropertyDescriptor(withNone, READS_A_WITNESS);
    await expect(d!.value()).rejects.toThrow(/built as though it reads no private state/);
    const withKey = interfaceOver('a-key:acct').callTx as any;
    await expect(Object.getOwnPropertyDescriptor(withKey, READS_A_WITNESS)!.value())
      .resolves.toBe('TX');
  });
});

describe('the set is the contract\'s, and a dropped one says so', () => {
  /*
   * **THE ONE CIRCUIT THIS SET USED TO HOLD WAS THE ONE THE CALL BUILDER COULD
   * REACH, AND THE INTERFACE CARRIES MORE THAN THAT.** Both of the others read
   * no witness: neither opens with a signer check, and the salt the vault's
   * entry point recomputes an identity from is an argument there rather than a
   * witness.
   *
   * RED WHEN: either is dropped from the set. They are then handed a key they
   * do not read without complaint, and refused when handed `null` with a
   * sentence claiming a signer check the contract does not have.
   */
  it('holds every circuit on this contract that reads no witness', () => {
    expect([...CIRCUITS_THAT_READ_NO_WITNESS].sort())
      .toEqual(['closeExpiredRun', 'recordPayment', 'retireVault']);
  });

  /*
   * RED WHEN: the `has` at the heart of the rule is reached with nothing. The
   * failure is then a `TypeError` about a property of undefined, in the one
   * file whose whole subject is that a dropped argument must name itself.
   */
  it('names a dropped set rather than dereferencing it', () => {
    expect(whyThisCallCannotBeBuilt(READS_A_WITNESS, 'a-key:acct', undefined as any))
      .toMatch(/nothing said which of this contract's circuits read no witness/);
    expect(() => refuseACallWithoutItsPrivateState(READS_A_WITNESS, 'a-key:acct', null as any))
      .toThrow(/nothing said which of this contract's circuits read no witness/);
  });
});

describe('the find requires the answer and hands back an interface that refuses', () => {
  /*
   * The scheme's seam, mirrored. `findDeployedPartialContract` imports the
   * module at call time, so this governs it.
   */
  const findWith = async (privateStateId: string | null) => {
    vi.resetModules();
    const built: unknown[] = [];
    vi.doMock('@midnight-ntwrk/midnight-js-contracts', () => ({
      verifyContractState: () => {},
      createCircuitCallTxInterface: (
        _p: unknown, _c: unknown, _a: unknown, key: unknown,
      ) => {
        built.push(key);
        return { [READS_A_WITNESS]: async () => 'TX', [READS_NONE]: async () => 'TX' };
      },
    }));
    const { findDeployedPartialContract } = await import('./partial-contract.js');
    const providers = {
      publicDataProvider: { queryContractState: async () => ({ operation: () => undefined }) },
      zkConfigProvider: { getVerifierKeys: async (names: string[]) => names.map((n) => [n, new Uint8Array()]) },
    };
    const found = await findDeployedPartialContract(providers as any, {
      compiledContract: {}, contractAddress: 'addr_under_test', privateStateId,
    });
    return { found, built };
  };

  /*
   * **THE GAP THIS ROUND CLOSED, STATED AS A CASE.** Before the change this
   * find took an optional key, and an interface built without one called every
   * circuit against nothing.
   *
   * RED WHEN: the find returns `createCircuitCallTxInterface`'s result
   * unwrapped. Watched: with the wrapper removed from `partial-contract.ts`
   * this resolves to `'TX'` instead of rejecting.
   */
  it('an interface found with no key refuses the circuits that read one', async () => {
    const { found } = await findWith(null);
    await expect((found.callTx as any)[READS_A_WITNESS]()).rejects
      .toThrow(/built as though it reads no private state/);
  });

  /*
   * RED WHEN: the find starts inventing an answer - a default, a `?? null`, or
   * a cast that turns `null` into an absent field on the way past. The key the
   * caller gave has to be the key the scheme is configured with, or the two
   * halves of this guard are judging different calls.
   */
  it('hands the scheme the answer it was given, unchanged, either way', async () => {
    expect((await findWith(null)).built).toEqual([null]);
    expect((await findWith('a-key:acct')).built).toEqual(['a-key:acct']);
  });

  /* THE CONTROL. RED WHEN: the find refuses a sound pair. */
  it('an interface found with a key calls the circuits that read one', async () => {
    const { found } = await findWith('a-key:acct');
    await expect((found.callTx as any)[READS_A_WITNESS]()).resolves.toBe('TX');
  });
});

/**
 * V-82: HOW THE VAULT CLIENT MUST TALK TO MIDNIGHT-JS, PINNED AGAINST THE REAL
 * SDK AND THE REAL COMPILED VAULT — not against a fake of either.
 *
 * The defect this file exists to make impossible again: the payee's encryption
 * mapping was passed as a TRAILING argument. midnight-js reads it from one
 * place only — a `TransactionContext` in FIRST position, identified by a
 * module-private `unique symbol` and read through the method
 * `getAdditionalMappings()`. So the mapping was silently dropped, and the
 * options object became a thirteenth argument to a circuit that declares twelve.
 *
 * **Nothing caught it because the fake accepted any convention, and the comment
 * beside the fake wrote the wrong one down as fact.** So the two assertions
 * that matter here touch no fake at all:
 *
 *   1. the real `withContractScopedTransaction` builds a context that hands our
 *      mapping back, under the option name we use
 *   2. the real `contracts/managed-vault/compiler/contract-info.json` says
 *      `payout` takes twelve, and a thirteenth is refused
 */
import { describe, it, expect } from 'vitest';
import { arityFrom, assertArity, forgetArities } from './circuit-arity.js';
import { planCall } from './vault-ledger.js';

const VAULT_ARTEFACTS = new URL('../../contracts/managed-vault', import.meta.url).pathname;
const ACCOUNT_ARTEFACTS = new URL('../../contracts/managed', import.meta.url).pathname;

const COIN = 'aa'.repeat(32);
const ENC = 'bb'.repeat(32);

describe('the mapping travels on the transaction context — against the real SDK', () => {
  it('the scope hands back exactly the map we gave it, through getAdditionalMappings()', async () => {
    const { withContractScopedTransaction } =
      await import('@midnight-ntwrk/midnight-js-contracts');

    const mappings = new Map([[COIN, ENC]]);
    let fromContext: unknown;
    let isMethod = false;

    /*
     * The scope throws at the end because our function makes no circuit call —
     * there is nothing to submit. **That rejection is part of the assertion**:
     * it proves the real submit path was reached rather than a stub, so the
     * context we inspected is the one a real call would receive.
     */
    await expect(withContractScopedTransaction(
      {} as never,
      (async (txCtx: any) => {
        isMethod = typeof txCtx.getAdditionalMappings === 'function';
        fromContext = txCtx.getAdditionalMappings();
      }) as never,
      { additionalCoinEncPublicKeyMappings: mappings } as never,
    )).rejects.toThrow(/No calls were submitted/);

    expect(isMethod).toBe(true);
    expect(fromContext).toBe(mappings);
    expect([...(fromContext as Map<string, string>).entries()]).toEqual([[COIN, ENC]]);
  });

  it('a context built with no mappings hands back undefined, not an empty map', async () => {
    const { withContractScopedTransaction } =
      await import('@midnight-ntwrk/midnight-js-contracts');
    let fromContext: unknown = 'unset';
    await expect(withContractScopedTransaction(
      {} as never,
      (async (txCtx: any) => { fromContext = txCtx.getAdditionalMappings(); }) as never,
    )).rejects.toThrow(/No calls were submitted/);
    /*
     * Which is why `planCall` always builds a map, even an empty one: the
     * difference between "no mapping" and "an empty mapping" is a build the
     * platform refuses versus one it does not, and it should never depend on
     * which branch a caller took.
     */
    expect(fromContext).toBeUndefined();
  });
});

describe('arity, against the vault\'s own compiled ABI', () => {
  it('payout declares twelve arguments, and deposit one', () => {
    forgetArities();
    expect(arityFrom(VAULT_ARTEFACTS)('payout')).toBe(12);
    /*
     * ONE SINCE S6a, and this line is the guard that would catch a client still
     * passing a blinding. `deposit` took the blinding as a second argument and
     * the vault wrote down whatever it was handed; the circuit derives
     * it now, so a second argument is a call the ABI refuses rather than a
     * value nobody can reproduce.
     */
    expect(arityFrom(VAULT_ARTEFACTS)('deposit')).toBe(1);
    /* And the two circuits S6a added, read from the same ABI. */
    expect(arityFrom(VAULT_ARTEFACTS)('splitNote')).toBe(2);
    expect(arityFrom(VAULT_ARTEFACTS)('retire')).toBe(2);
  });

  /* THE DEFECT ITSELF. An options object appended to the arguments is a 13th. */
  it('REFUSES A THIRTEENTH ARGUMENT — this is V-82 in one line', () => {
    expect(() => assertArity(arityFrom(VAULT_ARTEFACTS), 'payout', 13))
      .toThrow(/circuit "payout" takes 12 argument\(s\), got 13/);
  });

  it('accepts twelve', () => {
    expect(() => assertArity(arityFrom(VAULT_ARTEFACTS), 'payout', 12)).not.toThrow();
  });

  it('reads the VAULT\'s ABI and not the account\'s, which declares different circuits', () => {
    /*
     * The two contracts have different circuits with different arities. A guard
     * pointed at the wrong artefacts is confidently wrong, which is worse than
     * absent — so the path is a constructor argument rather than something read
     * off a config that happens to name the account's.
     */
    expect(arityFrom(ACCOUNT_ARTEFACTS)('payout')).toBeNull();
    expect(arityFrom(VAULT_ARTEFACTS)('payout')).toBe(12);
  });

  it('says nothing rather than guessing about a circuit it cannot find', () => {
    expect(arityFrom(VAULT_ARTEFACTS)('nosuchcircuit')).toBeNull();
    expect(() => assertArity(arityFrom(VAULT_ARTEFACTS), 'nosuchcircuit', 99)).not.toThrow();
  });

  it('an unreadable path disables the guard rather than breaking the call', () => {
    expect(arityFrom('/no/such/place')('payout')).toBeNull();
  });
});

describe('THE CLIENT ITSELF, driven through the real scope with no seam overridden', () => {
  /*
   * The seam `vault-ledger.test.ts` overrides — `scopedCall` — is what lets the
   * client be driven without a node. **This test does not override it.** It runs
   * the real `withContractScopedTransaction` and watches what the CIRCUIT
   * receives, which is the only place the V-82 defect was ever visible.
   *
   * The scope throws at the end because no real call was submitted. That is
   * expected and asserted: by then the circuit has already been called, and
   * what it was called with is the whole question.
   */
  it('hands the circuit a real transaction context FIRST, then exactly the arguments', async () => {
    const { VaultLedger } = await import('./vault-ledger.js');

    let received: unknown[] = [];
    const contract = {
      callTx: {
        deposit: async (...raw: unknown[]) => { received = raw; return {}; },
      },
    };

    /*
     * A deposit journal that accepts the line, because a private deposit through a
     * ledger without one is refused before this convention is ever reached.
     */
    const ledger = new VaultLedger(
      { networkId: 'preview' } as never, {} as never, async () => ({}) as never, {} as never,
      { load: async () => ({ notes: [] }), save: async () => {} } as never,
      VAULT_ARTEFACTS, undefined,
      {
        claim: async (_v: string, money: { token: string; value: bigint }, attemptedAt: string) =>
          ({ coin: { nonce: '77'.repeat(32), token: money.token, value: money.value }, attemptedAt }),
      },
      { everCreated: async () => new Set<string>() },
    );
    (ledger as any).connect = async () => contract;
    /* The vault's note set, read before the claim; this convention is about the call after it. */
    (ledger as any).chainNotes = async () => ({ member: () => false, size: () => 0n });

    await expect(ledger.deposit(
      'ab'.repeat(32), { token: 'aa'.repeat(32), value: 1n },
      { id: 'kc' } as never,
    )).rejects.toThrow(/No calls were submitted/);

    /* First: a real context, carrying the one method midnight-js reads off it. */
    expect(typeof (received[0] as any)?.getAdditionalMappings).toBe('function');
    /* Then the circuit's own arguments — ONE for deposit since S6a, and nothing
     * after. It used to be two; the blinding is derived in-circuit now. */
    expect(received).toHaveLength(2);
  });
});

describe('THE TWO SEAMS THE FIX ITSELF LIVES ON, driven for real', () => {
  /*
   * WHY THESE EXIST, and it is uncomfortable enough to write down.
   *
   * The first version of this fix could be REVERTED WITH THE WHOLE SUITE GREEN.
   * Both test files override `connect` and one overrides `scopedCall`, so the
   * two lines that actually carry V-82 — the witnesses going onto the
   * `CompiledContract`, and the mapping going onto the scope — were executed by
   * nothing. **That is the shape of V-82 reproduced one layer down**: the pure
   * part pinned purely, the SDK part pinned in isolation, and the seam between
   * them pinned by a stand-in. Found by an audit, not by the suite.
   */

  /*
   * The witness half lives in `vault-witness-binding.test.ts`, which has to
   * intercept `findDeployedContract` to see what `connect` hands it and so
   * needs a module mock this file must not have.
   */

  it('the REAL scopedCall carries the payee mapping to the circuit\'s context', async () => {
    const { VaultLedger, planCall } = await import('./vault-ledger.js');

    let seenByCircuit: unknown;
    const ledger: any = new VaultLedger(
      { networkId: 'preview' } as never, {} as never, async () => ({}) as never, {} as never,
      { load: async () => ({}), save: async () => {} } as never, VAULT_ARTEFACTS);

    const plan = planCall('payout', ['arg'], { [COIN]: ENC });

    /*
     * No override. The real `scopedCall` runs the real
     * `withContractScopedTransaction`, and the circuit records the context it
     * was handed. The scope then throws because nothing was submitted — which
     * is asserted, because it proves the real submit path was reached rather
     * than a stub short-circuiting before it.
     */
    await expect(ledger.scopedCall(
      async (txCtx: any, ...args: unknown[]) => {
        seenByCircuit = txCtx?.getAdditionalMappings?.();
        expect(args).toEqual(['arg']);
        return {};
      },
      plan,
    )).rejects.toThrow(/No calls were submitted/);

    expect(seenByCircuit).toBeDefined();
    expect([...(seenByCircuit as Map<string, string>).entries()]).toEqual([[COIN, ENC]]);
  });
});

describe('the plan a call is made from', () => {
  it('keeps the circuit arguments and nothing else', () => {
    const plan = planCall('payout', [1, 2, 3], { [COIN]: ENC });
    expect(plan.args).toEqual([1, 2, 3]);
    expect([...plan.mappings.entries()]).toEqual([[COIN, ENC]]);
  });

  it('always has a map, so no call is assembled by a path that has none', () => {
    expect(planCall('deposit', [1, 2]).mappings.size).toBe(0);
  });

  it('copies the arguments, so a caller mutating its array cannot change the call', () => {
    const args: unknown[] = [1, 2];
    const plan = planCall('deposit', args);
    args.push(3);
    expect(plan.args).toEqual([1, 2]);
  });
});

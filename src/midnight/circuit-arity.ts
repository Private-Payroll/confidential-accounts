/**
 * HOW MANY ARGUMENTS A CIRCUIT ACTUALLY DECLARES. M-38, and now V-82.
 *
 * ONE DEFINITION, AND THAT IS THE POINT OF THE FILE. This lived privately in
 * `ledger.ts` and served the account. The vault client never got it, and the
 * defect that followed — an options object passed as a thirteenth argument to a
 * circuit that declares twelve — is exactly what it would have caught. There are
 * two clients now, and "the same rule written twice" is this project's most
 * expensive habit, so the rule is here and both import it.
 *
 * WHY NOT `fn.length`. Because it is always 0. Every generated circuit wrapper
 * is `(...args) => {…}`, and a rest parameter contributes nothing to
 * `Function.length`. The first version of this guard read it, so it never fired
 * — and the test missed that because the stub was ALSO written with `(...args)`.
 * **A test built from the same wrong model as the code cannot catch the model.**
 *
 * `contract-info.json` is produced by compactc and is the only thing that knows
 * the real arity. Nothing else in the toolchain does: the runtime wrappers all
 * take rest parameters, and the TypeScript types are generated from the same
 * source rather than from the deployed contract.
 *
 * AND THE THIRD THING, WHICH IS WHY THIS FILE READS A FILE RATHER THAN CALLING
 * `require`. The version this replaced used `require(...)` inside a bare
 * `try/catch`. This repo is ESM, and under `tsx` — which is how the server and
 * every script actually run — **`require` is not defined**. The `ReferenceError`
 * was swallowed, the lookup returned null, and `assertArity` checked nothing.
 * Vitest supplies `require`, so the guard reported the right arity in the one
 * runtime that never touches money and nothing in every runtime that does.
 *
 * Measured, not reasoned: `typeof require` is `undefined` under tsx and the same
 * call returns `null` for a circuit that plainly declares twelve arguments.
 *
 * **It had been that way since M-38**, so the ACCOUNT's guard had never fired
 * either. That is the real lesson and it is not about `require`: **a guard whose
 * failure mode is to disable itself is not a guard.** So this reads the file
 * with `fs`, which behaves identically in both runtimes, and it swallows exactly
 * one error — the file not being there, which is a real and expected
 * configuration — and lets every other error out.
 *
 * NODE-SIDE ONLY. If a browser bundle ever imports this, the build fails on
 * `node:fs`, which is the correct failure: the alternative is a guard that is
 * quietly absent in one of the places it is needed, and that is the whole story
 * above.
 */
import { readFileSync } from 'node:fs';

export type ArityLookup = (circuit: string) => number | null;

const caches = new Map<string, Record<string, number>>();

/**
 * Reads a compiled contract's declared arities.
 *
 * `zkConfigPath` is the directory holding `compiler/contract-info.json` — the
 * ACCOUNT's and the VAULT's are different directories, and handing one client
 * the other's would produce a guard that is confidently wrong, which is worse
 * than none. Callers pass their own.
 *
 * **Returns null for a circuit it cannot find rather than a guess.** An unknown
 * circuit then fails on the call itself, which names it, instead of failing on
 * an assumption about it.
 */
export function arityFrom(zkConfigPath: string): ArityLookup {
  return (circuit: string): number | null => {
    try {
      let cached = caches.get(zkConfigPath);
      if (!cached) {
        const info = JSON.parse(
          readFileSync(`${zkConfigPath}/compiler/contract-info.json`, 'utf8'));
        cached = {};
        for (const c of info?.circuits ?? []) {
          if (typeof c?.name === 'string' && Array.isArray(c?.arguments)) {
            cached[c.name] = c.arguments.length;
          }
        }
        caches.set(zkConfigPath, cached);
      }
      const n = cached[circuit];
      return typeof n === 'number' ? n : null;
    } catch (e) {
      /*
       * ONLY "the file is not there" is survivable, and only because a client
       * configured without compiled artefacts is a real situation. Malformed
       * JSON, a permissions error, a truncated file — every one of those means
       * the ABI we are about to check against is not what we think, and a guard
       * that shrugs at that is the defect this file was rewritten for.
       */
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw e;
    }
  };
}

/**
 * Refuses a call whose argument count does not match what the contract declares.
 *
 * Called with the arguments that are going to the CIRCUIT — never with anything
 * the SDK wraps around them. A transaction context is not a circuit argument and
 * must not be counted here.
 */
export function assertArity(arity: ArityLookup, circuit: string, argCount: number): void {
  const expected = arity(circuit);
  if (expected !== null && argCount !== expected) {
    throw new Error(`circuit "${circuit}" takes ${expected} argument(s), got ${argCount}`);
  }
}

/**
 * Forgets what has been read, so a fixture that changes on disk is picked up.
 *
 * This is now TRUE. It was not when the file used `require`: Node's own module
 * cache is keyed by resolved path and clearing ours did nothing, so a test that
 * rewrote a fixture got the stale answer and no failure. Reading the file
 * ourselves is what makes this comment a fact rather than an intention.
 */
export const forgetArities = (): void => { caches.clear(); };

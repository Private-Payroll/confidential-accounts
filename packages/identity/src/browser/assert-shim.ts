/**
 * NODE'S `assert`, PUT WHERE A BROWSER CAN FIND IT — `buffer.ts`'s story
 * Met again one package deeper, found by the probe.
 *
 * `@midnightntwrk/wallet-sdk-address-format` encodes the DUST address
 * through `@subsquid/scale-codec`, which is CommonJS and does
 * `require("assert")` — Node's built-in. Vite's browser stand-in for that
 * built-in is an empty object, so the first time the wallet derived a DUST
 * address in a real browser it threw `assert_1.default is not a function` —
 * while 460+ tests stayed green, because vitest runs in Node where the real
 * `assert` exists. The probe is the thing that caught it, which is exactly
 * the job it was built for.
 *
 * `vite.config.ts` aliases `assert` to this file. It implements the two
 * shapes scale-codec actually calls — `assert(condition, message)` and
 * `assert.strictEqual(a, b, message)` — by throwing, which is all Node's
 * does on failure. Nothing else imports it; the app's own code never uses
 * `assert`.
 */

interface AssertShim {
  (condition: unknown, message?: string | Error): asserts condition;
  ok(condition: unknown, message?: string | Error): asserts condition;
  strictEqual(actual: unknown, expected: unknown, message?: string | Error): void;
}

const fail = (message?: string | Error): never => {
  throw message instanceof Error ? message : new Error(message ?? 'assertion failed');
};

const assertShim = ((condition: unknown, message?: string | Error): void => {
  if (!condition) fail(message);
}) as AssertShim;

assertShim.ok = assertShim;
assertShim.strictEqual = (actual, expected, message) => {
  if (actual !== expected) {
    fail(message ?? `expected ${String(actual)} to strictly equal ${String(expected)}`);
  }
};

export default assertShim;
export const ok = assertShim.ok;
export const strictEqual = assertShim.strictEqual;

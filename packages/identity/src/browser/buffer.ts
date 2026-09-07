import { Buffer } from 'buffer';

/**
 * NODE'S `Buffer`, PUT WHERE A BROWSER CAN FIND IT — and this is not tidying,
 * it is the difference between the wallet working and not.
 *
 * `@midnightntwrk/wallet-sdk-address-format` is written against `Buffer`:
 * `Buffer.from`, `Buffer.concat`, and a `Buffer` coming back out of every
 * decode. In Node that is a global and nobody notices. **In a browser it does
 * not exist**, so the first thing the standalone wallet did when it tried to
 * show somebody their own address was throw `ReferenceError: Buffer is not
 * defined`.
 *
 * The whole test suite was green while that was true, because vitest runs in
 * Node. Deriving the keys worked in the browser — that is all `@noble` and
 * `@scure`, which are written for both — and only the step that turns them into
 * an address failed. `address.browser.test.ts` is the test that would have
 * caught it, and it works by taking `Buffer` away.
 *
 * IT IS HERE AND NOT IN THE CORE ON PURPOSE. `keys/`, `wallet/`, `recovery/`
 * and `passkey/` take values and return values; a global is a platform, and
 * platforms live in `browser/`. A host bundling this for a browser imports
 * `midnight-identity/browser`, which calls this, and a Node host never loads it.
 */

/**
 * Installs `Buffer` if the runtime does not have one. Safe to call repeatedly,
 * and it never replaces a `Buffer` that is already there — a host with its own
 * polyfill keeps it.
 *
 * **CALL IT. Do not rely on importing this file for its side effect.** The
 * first version did exactly that, and `package.json` declared the package
 * `"sideEffects": false` — which is a promise to bundlers that no module does
 * anything on import, so the bundler removed it. The build was clean, the
 * bundle had no polyfill in it, and the wallet failed identically to before.
 * The manifest now names this file as the exception; calling the function is
 * what makes that no longer something to get right.
 */
export function ensureBuffer(): void {
  const global = globalThis as { Buffer?: unknown };
  if (global.Buffer === undefined) global.Buffer = Buffer;
}

/* Also on import, for a host that does `import 'midnight-identity/browser'`. */
ensureBuffer();

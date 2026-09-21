import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { toHex, utf8, type WrappingKeypair } from './crypto.js';

/**
 * **THE DERIVATION ON ITS OWN, WITH NOTHING BEHIND IT.**
 *
 * ── WHY THIS IS A FILE AND NOT A FUNCTION IN THE ONE NEXT DOOR ───────────
 *
 * `payslip-key.ts` imports `identityFromWords` from `midnight-identity`, which
 * is the wallet's ROOT BARREL — passkeys, pairing, recovery, the wallet SDK and
 * `@midnightntwrk/ledger-v9` behind all of it. That is right where it is: the
 * seed walks the wallet's real code on purpose.
 *
 * **BUT THE PAYROLL PAGE NOW NEEDS THE DERIVATION TOO** — a founder making
 * themselves payable derives their own payslip keypair in the browser — and
 * importing it from there put twenty-four ledger modules and a 10 MB `.wasm`
 * asset back into the page's module graph. **That is a failure this project has
 * already had**: a blank page in every real browser, from one small function
 * imported across a file that had the wallet SDK behind it. Measured, not
 * feared: `no-wasm-in-the-page.test.ts` went red the moment the import was
 * added and green again on this split.
 *
 * **ONE DERIVATION, STILL.** Nothing was copied. `payslip-key.ts` imports this
 * and re-exports it, so the seed, the tests and the page all expand the same
 * bytes through the same line.
 */

/**
 * **THE KEY THAT OPENS A PERSON'S PAYSLIPS IS DERIVED, NOT MINTED AND KEPT.**
 * `docs/NEXT.md` PI2b §2.
 *
 * ── WHAT WAS WRONG WITH THE OLD ONE ───────────────────────────────────────
 *
 * `newWrappingKeypair()` is `x25519.utils.randomSecretKey()`
 * (`src/core/crypto.ts:31-34`). **A random key has to be kept, and a kept key
 * can be lost.** Nothing recomputes it — not the employee, not a new device,
 * not a recovery, not another client, not us. The payslips stay intact, stay
 * sealed, and are gone.
 *
 * ── AND IT IS KEPT NOWHERE, WHICH IS EASY TO GET WRONG ────────────────────
 *
 * The employee's key has been taken to be *"kept in our database in the user's
 * sealed bundle (`types.ts:61-62`)"*. **It is not, and nothing else keeps it
 * either.** `types.ts:61-62` is the keyring bundle, which holds a SIGNER's
 * wrapping secret — the one that unwraps the account viewing key. The
 * employee's payslip secret appears in `EmployeeSecret` (`payroll.ts:181-185`),
 * is handed back once by the seed, and is written to no store, no column and no
 * bundle: grep `wrappingSecret` across `src/` and every hit is a signer's, a
 * test's, or the demo's React state.
 *
 * **AND THAT IS WORSE THAN IT SOUNDS, NOT BETTER.** A key kept somewhere
 * fragile would at least be somewhere. There is nowhere at all — no employee
 * keyring exists — so the key is handed over once and survives only in whatever
 * the person's browser was holding at the time.
 *
 * ── WHAT IT IS DERIVED FROM, AND WHAT IT IS DELIBERATELY NOT ──────────────
 *
 * **FROM THE KEY THE WALLET ALREADY RELEASES FOR THAT COMPANY, AND FROM NOTHING
 * ELSE.** `unlock.ts:92-101` in the wallet says that input was built to be fit
 * for it: thirty-two bytes of HKDF-SHA256, a pure function of a seed and a
 * chain-assigned address, recomputable on any device and after any recovery,
 * stored nowhere.
 *
 * **THE EMPLOYEE ID IS NOT AN INGREDIENT, AND THAT IS THE ONE DECISION HERE
 * WORTH ARGUING.** It is the obvious thing to add, and it would reintroduce one
 * level down exactly the loss this file exists to rule out. `emp_` ids are OURS
 * TO MINT: re-invite somebody, rebuild a roster, migrate a store, and the id
 * moves — and every payslip sealed under the old one becomes unopenable, with a
 * person's whole pay history inside it. **Nothing this side invents may reach
 * this derivation.** So one person has ONE payslip key per company, for as long
 * as the company exists, and every slip they were ever issued opens with it.
 *
 * **THE ORIGIN IS NOT AN INGREDIENT EITHER**, because it is not one upstream:
 * `unlock.ts` gates on the origin and derives from the company. So the same
 * person reaching the same company from a self-hosted client gets the same
 * payslip key, which keeps every payslip openable from any client and is the
 * entire reason the parent was changed.
 *
 * ── AND IT IS NOT THE KEY IT COMES FROM ───────────────────────────────────
 *
 * Domain-separated, because no key in this system does two jobs. The released
 * key opens the company keyring; this one opens payslips. Holding one must not
 * be holding the other, and a one-way expansion is what makes that true rather
 * than asserted.
 *
 * **MEASURED, NOT ASSERTED — any thirty-two bytes are a usable x25519 secret.**
 * `x25519` is built with `adjustScalarBytes` (`@noble/curves/ed25519.js:57`,
 * wired in at `:223`), which is applied to every scalar at
 * `@noble/curves/abstract/montgomery.js:181`. So the clamping happens inside
 * the curve and an HKDF output needs no preparation. Run here rather than read:
 * a public key derives, ECDH agrees both ways, and the same input gives the
 * same bytes twice.
 */

/**
 * The domain this expansion lives in. **`v1`, and the day it changes is the day
 * every payslip stops opening** — so it is a migration and never a patch. The
 * same rule, and for the same reason, as the wallet's `UNLOCK_SALT`.
 */
const PAYSLIP_SALT = utf8('midnight-payroll/payslip-wrapping/v1');

/** One key per person per company. There is no index and nothing chooses one. */
const NO_INFO = new Uint8Array(0);

/** 32 bytes, which is what x25519 takes and what the released key already is. */
const KEY_BYTES = 32;

/**
 * **THE PERSON'S PAYSLIP KEYPAIR FOR ONE COMPANY.** A pure function of the key
 * their wallet released for that company, and of nothing else.
 *
 * Takes the released bytes rather than an identity and an ask, because that is
 * the boundary: **the wallet decides whether to release, and this decides
 * nothing.** A caller holding the released key has already been through the
 * person's own press on the wallet's screen.
 */
export function payslipKeypairFrom(companyKey: Uint8Array): WrappingKeypair {
  if (companyKey.length !== KEY_BYTES) {
    /*
     * A LOUD REFUSAL AND NOT A SHORTER KEY. Something that is not a released
     * key would otherwise expand into a perfectly usable keypair that nothing
     * will ever derive again — a payslip sealed to nobody, discovered when the
     * person tries to read it.
     */
    throw new Error(
      `a payslip key is derived from the ${KEY_BYTES}-byte key the wallet releases for a `
      + `company, and that was ${companyKey.length} bytes`);
  }
  const secret = hkdf(sha256, companyKey, PAYSLIP_SALT, NO_INFO, KEY_BYTES);
  return { secret: toHex(secret), publicKey: toHex(x25519.getPublicKey(secret)) };
}


/**
 * Deterministic filler bytes for the preview scripts. M-137.
 *
 * **IT DECIDES NO IDENTITY ANY MORE, AND THAT IS `C334`.** `S35`, 31 Aug.
 *
 * WHAT THIS FILE USED TO BE. `deploy-preview.ts` seated signer A's leaf on
 * chain and `run-preview.ts` had to prove membership of that same leaf several
 * minutes later, so A's identity was `seededBytes(1)` and `seededBytes(401)` in
 * both — one place rather than two copies held together by a comment, which
 * fixed M-104's half of the problem and left the other half standing.
 *
 * THE OTHER HALF: `out[i] = (seed * 31 + i * 7) % 256` IS PUBLISHED. This
 * repository is going public, so every signer these scripts seated on a real
 * account was an identity any reader could take — and A's seat came from the
 * CONSTRUCTOR, so it was on every account this project would ever deploy. The
 * header below said the right thing about it from the day it was written:
 *
 *   *"precisely the wrong thing for a real signer — there is no entropy here at
 *   all … real devices generate their keys with `newSigningKeypair` and their
 *   blindings with `newBlinding`, both in `src/core/crypto.ts`."*
 *
 * `scripts/preview-signers.ts` is that sentence carried out. **Nothing here
 * generates a secret key or a blinding any more.**
 *
 * WHAT IS LEFT, AND IT IS THE RIGHT TOOL FOR IT: payloads, batch digests and
 * salts that two processes must agree on across separate runs and separate
 * days, where determinism is the whole requirement and no seat and no money
 * turns on the value being unguessable. Nothing in `src/` imports this, and
 * nothing should.
 */
export const seededBytes = (seed: number): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 7) % 256;
  return out;
};

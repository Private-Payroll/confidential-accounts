import {
  payeeAddressFromKeys, unshieldedPayeeAddressFromKeys,
  type Payee, type PayeeAddress, type UnshieldedPayeeAddress,
} from '../midnight/payee-address.js';
import { toHex, type Hex } from '../core/crypto.js';

/**
 * A payee, for tests, from the coin-key bytes a test already has.
 *
 * ONE DEFINITION, ON PURPOSE. This repo's most expensive habit is one rule
 * written twice — `seededBytes` in two scripts with a comment in each saying
 * they must match, and `canonical()` in two modules that had drifted. A helper
 * that turns bytes into a payee is exactly the kind of thing that gets copied
 * into the next test file that needs it, so it lives here instead.
 *
 * THE ENCRYPTION KEY IS DERIVED FROM THE COIN KEY AND IS DELIBERATELY NOT EQUAL
 * TO IT. If every test payee shared one reading key, a test could not tell a
 * crossed pair from a correct one — which is the failure the address type
 * exists to make impossible, so the fixture must not hide it.
 */
export const payeeFor = (
  coinKey: Uint8Array | Hex,
  /*
   * REQUIRED, not defaulted, because `payeeAddress` refuses to default it and a
   * fixture that quietly does so teaches the opposite of what the type says. An
   * address is only meaningful on one network, and a default is how a testnet
   * address reaches a mainnet payroll.
   */
  network: Parameters<typeof payeeAddressFromKeys>[1],
): PayeeAddress => {
  const bytes = typeof coinKey === 'string'
    ? Uint8Array.from(coinKey.match(/../g)!.map(b => parseInt(b, 16)))
    : coinKey;
  return payeeAddressFromKeys({
    coinPublicKey: toHex(bytes),
    encryptionPublicKey: toHex(Uint8Array.from(bytes, b => b ^ 0x5a)),
  }, network);
};

/**
 * A PAYEE WHO IS PAID IN **PUBLIC** MONEY, from the same bytes a test already
 * has.
 *
 * Here rather than in the next test file for `payeeFor`'s reason, and one
 * stronger: a public payee and a private one built from the SAME 32 bytes are
 * the pair every kind-confusion test needs — a `UserAddress` and a
 * `ZswapCoinPublicKey` that are byte-for-byte identical and belong to different
 * key spaces, which is precisely `C246`'s hazard. A fixture that made them
 * differ would let a test pass because the bytes did not match, proving nothing
 * about the domain separation the contract exists to enforce.
 *
 * **There is no second key.** A UTXO addressed to a `UserAddress` is public and
 * the payee's wallet finds it by looking, so `V-77`'s encryption key has no
 * counterpart here — which is why this takes one value where `payeeFor`
 * derives two.
 */
export const unshieldedPayeeFor = (
  userAddress: Uint8Array | Hex,
  network: Parameters<typeof unshieldedPayeeAddressFromKeys>[1],
): UnshieldedPayeeAddress => {
  const bytes = typeof userAddress === 'string'
    ? Uint8Array.from(userAddress.match(/../g)!.map(b => parseInt(b, 16)))
    : userAddress;
  return unshieldedPayeeAddressFromKeys({ userAddress: toHex(bytes) }, network);
};

/**
 * **A ROSTER PAYEE, NARROWED TO THE PRIVATE KIND, FOR A TEST THAT IS ABOUT ONE.**
 *
 *
 * `RosterEmployee.address` is a `Payee` since `S12`, so a test reading
 * `coinPublicKey` off one no longer compiles — which is the compiler doing what
 * `payout-tree.ts` promised it would when the roster widened. **The right
 * repair is a narrowing that FAILS on the other kind**, not a cast: a cast in a
 * test about crossed key spaces is the one place a wrong kind would sail
 * through unnoticed.
 *
 * Here rather than in each test file for `payeeFor`'s reason. It was wanted in
 * three files in the round that added it.
 */
export const privatePayee = (p: Payee | null | undefined): PayeeAddress => {
  if (p == null) {
    throw new Error('there is no address here, and this test is about a private payee');
  }
  if (p.kind !== 'shielded') {
    throw new Error(`this payee is ${p.kind}, and this test is about a private one`);
  }
  return p;
};

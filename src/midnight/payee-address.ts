import {
  MidnightBech32m, ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk-address-format';
import type { Hex } from '../core/crypto.js';
import type { NetworkName } from './network.js';

/**
 * WHO A PAYMENT IS FOR — ONE VALUE, NEVER TWO FIELDS. A-1, and it closes V-80.
 *
 * Paying somebody on Midnight needs two 32-byte keys and they are different
 * keys — and since `S58` this file ENFORCES both widths on every route in,
 * rather than stating one and enforcing only the pairing (`T-194`):
 *
 *   the COIN public key       who may spend it. Goes to the circuit.
 *   the ENCRYPTION public key who may READ about it. Rides on the transaction,
 *                             in `additionalCoinEncPublicKeyMappings`, and is
 *                             what makes the payment appear in the payee's own
 *                             wallet.
 *
 * THE FAILURE THIS TYPE EXISTS TO DELETE, because it is silent and it is the
 * worst one in the register (`C7`):
 *
 *   no encryption key       midnight-js REFUSES to build the transaction. The
 *                           platform protecting us, and the right failure.
 *   the WRONG one           the payment settles perfectly — correct amount,
 *                           correct recipient, correct approval, on chain,
 *                           irreversible — into a coin the payee's wallet will
 *                           NEVER show them. Nothing anywhere objects, and no
 *                           assert can reach it: the mapping is a transaction
 *                           option, so it is not part of what the signers
 *                           approve.
 *
 * That asymmetry only exists because the two keys are two values that can
 * disagree. **Here they cannot.** A payee is one Bech32m string, both halves
 * come out of one decode of it, and there is no way to set either alone. A
 * wrong address is then a wrong RECIPIENT — loud, ordinary, and nothing like
 * paying the right person into a coin they cannot see.
 *
 * WHAT THIS DOES NOT FIX, said here so nobody reads more into it: an operator
 * can still hold the *wrong person's* correct address. That is `V-78` options 1
 * and 2 — pre-flight the built transaction, and bind a commitment to the key
 * into the approved leaf — and both are still open.
 *
 * NOTHING HERE IS OUR OWN CRYPTOGRAPHY OR OUR OWN ENCODING. `ShieldedAddress`
 * and its `shield-addr` codec are the platform's, from
 * `@midnightntwrk/wallet-sdk-address-format`, which is a direct dependency and
 * is what a wallet itself hands out (`getAddress()`).
 */

/*
 * The brand is a module-private unique symbol, so `PayeeAddress` cannot be
 * written as an object literal ANYWHERE else — including in a test, which is
 * the point. A shape somebody can forge in a test is a shape they will forge in
 * a hurry in production.
 */
declare const payeeBrand: unique symbol;
declare const unshieldedPayeeBrand: unique symbol;

export interface PayeeAddress {
  readonly [payeeBrand]: true;
  /**
   * WHICH KIND OF MONEY THIS PERSON CAN BE PAID IN, AND IT IS NOT A FLAG. `C246`.
   *
   * **Derived from the decode, exactly like `coinPublicKey` — never supplied.**
   * A `shield-addr` string decodes to this type and to no other; the platform's
   * own codec refuses to read it as anything else (`Bech32mCodec.decode` throws
   * `Expected type addr, got shield-addr`). So the kind and the 32 bytes that
   * go to a circuit come out of ONE parse of ONE value, and cannot disagree.
   *
   * That is the whole of `C246` at the client. The register's row is about a
   * leaf that did not say which kind of money it authorised; the contract
   * closed it with a fourth committed value and a domain separator, and what
   * was left was for the client to pick the right derivation per payee. A
   * `kind: 'shielded' | 'unshielded'` field beside a payee — settable, and
   * therefore settable wrongly — would have re-opened it one layer up.
   */
  readonly kind: 'shielded';
  /** The one canonical value: what is stored, shown, pasted and compared. */
  readonly bech32: string;
  /** The network this address is FOR. Part of the string; kept for messages. */
  readonly network: NetworkName;
  /**
   * Who may spend. Hex, 32 bytes.
   *
   * READONLY AND DERIVED. It and `encryptionPublicKey` come out of the same
   * decode of `bech32`, in the same expression, and neither can be supplied.
   */
  readonly coinPublicKey: Hex;
  /** Who may read about it. Hex, 32 bytes. Same decode as `coinPublicKey`. */
  readonly encryptionPublicKey: Hex;
}

/**
 * ONE ADDRESS PER PERSON — A-6, asked of the platform rather than assumed.
 *
 * A shielded wallet is started with exactly one `ZswapSecretKeys` and every
 * sync, apply and balance call takes that one object; `fromSeed` has no index
 * argument, and there is no key list, index loop, gap-limit scan or diversified
 * address anywhere in `wallet-sdk-shielded`, `wallet-sdk-facade` or
 * `ledger-v9`. So a wallet started at one derivation index would NEVER see
 * coins sent to another, and a fresh address per payer would make a payee's
 * salary invisible to their own wallet — silently.
 *
 * The cost, accepted and stated rather than designed around: two companies that
 * both pay somebody hold the same identifier for them. That is the platform's
 * property, not our choice.
 */

const HEX32 = /^[0-9a-f]{64}$/;

/**
 * **BOTH HALVES, BOTH WIDTHS, MEASURED RATHER THAN ASSUMED.** `T-194`, `S58`,
 * `REPORT-PAYEE-KEY.txt`.
 *
 * **THE COIN HALF WAS SAFE BY ACCIDENT AND THE ENCRYPTION HALF WAS NOT
 * CHECKED AT ALL.** The SDK's decoder throws inside `ShieldedCoinPublicKey`'s
 * constructor if the first 32 bytes are not 32 bytes, so a bad coin half never
 * reaches this function. **The encryption half is everything remaining** —
 * `bytes.subarray(32)`, handed to a constructor that only assigns and checks
 * nothing (`@midnightntwrk/wallet-sdk-address-format`, whose own
 * `static keyLength = 32` is dead code). So `build` accepted, froze and
 * returned a `PayeeAddress` whose `encryptionPublicKey` was any even number of
 * hex characters, and that value travelled to
 * `additionalCoinEncPublicKeyMappings` unexamined.
 *
 * **WHAT REFUSED IT INSTEAD, AND WHY THAT IS TOO LATE.** The ledger does:
 * `MEASURE-PAYEE-KEY.command` put every wrong width through `ZswapOutput.new`
 * and **every one THREW** — *failed to fill whole buffer* at 31 bytes, *Not all
 * bytes read* at 33 and 64 — and **every refusal was about LENGTH, none about
 * VALUE**, so no money can reach a key nobody holds by this route. But that
 * refusal arrives at transaction-build time: after the run is raised, after the
 * signatures, after the window opens. **This one arrives when the address is
 * parsed**, which is where a person can still fix it.
 *
 * **THE SAME `HEX32` AND THE SAME SENTENCE `payeeAddressFromKeys` USES**, so
 * the two doors in cannot come to disagree about what a key is — `M-104`'s
 * shape, avoided by sharing the check rather than by copying it.
 */
const build = (
  address: ShieldedAddress, bech32: string, network: NetworkName,
): PayeeAddress => Object.freeze({
  kind: 'shielded',
  bech32,
  network,
  /* One decode, both halves, one expression. This is the whole invariant. */
  coinPublicKey: requireHex32(address.coinPublicKey.toHexString(), 'coin public key'),
  encryptionPublicKey:
    requireHex32(address.encryptionPublicKey.toHexString(), 'encryption public key'),
}) as PayeeAddress;

/**
 * 32 bytes of lowercase hex, or a refusal naming which half was wrong. One
 * definition, used by `build` and by `payeeAddressFromKeys`. `T-194`, `S58`.
 */
const requireHex32 = (key: string | undefined, what: string): Hex => {
  if (!HEX32.test(key ?? '')) {
    throw new Error(
      `the ${what} must be 32 bytes of lowercase hex; got ${key ? `"${key}"` : 'nothing'}`);
  }
  return key as Hex;
};

/**
 * The way an address ENTERS the system: parsed, checked, and never trusted.
 *
 * Three things are checked and all three are the platform's own checks rather
 * than ours: the Bech32m checksum (a typo does not decode), the address TYPE
 * (`shield-addr` — a coin-public-key-only string is refused), and the NETWORK
 * (a preview address handed to a stagenet deployment throws by name).
 *
 * `network` is required and not defaulted. An address is only meaningful on one
 * network, and a default is how a testnet address reaches a mainnet payroll.
 */
export function payeeAddress(bech32: string, network: NetworkName): PayeeAddress {
  const raw = (bech32 ?? '').trim();
  if (!raw) throw new Error('a payee address is required, and this one is empty');

  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(raw);
  } catch (e) {
    /*
     * Names the address rather than repeating the library's message alone: the
     * one thing the reader needs is WHICH value was rejected, and a bech32m
     * failure that does not say so sends somebody looking at the wrong field.
     */
    throw new Error(
      `"${raw}" is not a Midnight address: ${(e as Error).message}. `
      + 'A payee address looks like mn_shield-addr_<network>1... and carries its own checksum.');
  }

  let address: ShieldedAddress;
  try {
    address = parsed.decode(ShieldedAddress, network);
  } catch (e) {
    throw new Error(
      `"${raw}" is not a payee address for ${network}: ${(e as Error).message}. `
      + 'It must be a shield-addr — a coin public key on its own is not enough to pay somebody, '
      + 'because it does not say who may READ the payment.');
  }

  return build(address, parsed.asString(), network);
}

/**
 * The ONE place two halves are legitimately known separately: a wallet we hold,
 * or a device that has just derived its own keys.
 *
 * It exists so that path produces a real address rather than a pair of fields
 * travelling together by convention — **and it immediately re-parses its own
 * output**, so the value returned came out of a decode exactly like every other
 * one. There is deliberately no way to make a `PayeeAddress` that skipped it.
 *
 * THE KEYS ARE NAMED FIELDS AND NOT POSITIONAL ARGUMENTS, and that is worth a
 * paragraph because the first version of this function had them positional.
 *
 * Two parameters of the same type, side by side, transpose silently: it
 * type-checks, the address is well formed, frozen and brand-carrying, and it is
 * indistinguishable downstream from one that came out of a wallet. **The money
 * then settles to the payee's ENCRYPTION key used as a coin public key, and
 * nobody holds the spending secret for it** — worse than `C7`, because there is
 * no payer's history to re-serve from. Named fields do not make that impossible,
 * but they make it something somebody has to write down rather than something
 * they can slip into.
 *
 * **This still cannot tell whether the two halves are one person's.** Round
 * tripping proves the encoding, never the pairing. The path that guarantees the
 * pairing is the payee producing the address themselves — A-2 — and until then
 * this is the boundary where that trust is placed.
 */
export function payeeAddressFromKeys(
  keys: { coinPublicKey: Hex; encryptionPublicKey: Hex }, network: NetworkName,
): PayeeAddress {
  const { coinPublicKey, encryptionPublicKey } = keys;
  /* `requireHex32` is `build`'s check too, since `S58` — one definition rather
   * than this loop and a silence at the other door. `T-194`. */
  requireHex32(coinPublicKey, 'coin public key');
  requireHex32(encryptionPublicKey, 'encryption public key');
  /*
   * NEITHER HALF IS CHECKED FOR BEING A USABLE KEY, only for being 32 bytes.
   * `fromHexString` is a container, not a validator: nothing here confirms the
   * encryption half is a point anybody can encrypt to. An address built from 32
   * arbitrary bytes encodes, decodes and compares equal all the way through.
   * Recorded rather than papered over — see the register.
   */
  const address = new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(encryptionPublicKey));
  return payeeAddress(MidnightBech32m.encode(network, address).asString(), network);
}

/* ------------------------------------------------------------------------
 * THE OTHER KEY SPACE. C245, C246, S6k.
 * ------------------------------------------------------------------------ */

/**
 * WHO A PAYMENT IN **PUBLIC** MONEY IS FOR — ONE VALUE, ONE KEY, AND A
 * DIFFERENT KEY SPACE FROM EVERYTHING ABOVE.
 *
 * NIGHT is an unshielded token by definition (`nativeToken(): UnshieldedTokenType`),
 * and `Vault.compact`'s `payoutUnshielded` sends to
 * `right<ContractAddress, UserAddress>(UserAddress { bytes: recipient })`. A
 * `UserAddress` is `{ bytes: Bytes<32> }` — **the same 32 bytes wide as a
 * `ZswapCoinPublicKey` and belonging to an entirely different key space.** That
 * coincidence is `C246`: nothing downstream of a raw 32 bytes can tell which
 * space they came from, and an unshielded send to an address in the wrong one
 * removes the money permanently, with no unshielded burn address to distinguish
 * a mistake from an intention.
 *
 * **THERE IS NO SECOND KEY HERE, AND THAT IS A PLATFORM FACT RATHER THAN A
 * SIMPLIFICATION.** `V-77`'s obligation — the payer must carry the payee's
 * ENCRYPTION key so their wallet can find a shielded coin — has no counterpart:
 * a UTXO addressed to a `UserAddress` is public and the payee's wallet finds it
 * by looking. So `C7`'s silent failure, the correct recipient paid into a coin
 * they can never see, cannot arise on this side. It remains exactly as dangerous
 * on the shielded one.
 *
 * **WHAT THIS TYPE STILL CANNOT STOP** is the same thing `PayeeAddress` cannot:
 * the wrong person's correct address. `V-78`.
 *
 * NOTHING HERE IS OUR OWN ENCODING. `UnshieldedAddress` and its `addr` codec are
 * the platform's, from `@midnightntwrk/wallet-sdk-address-format` — the same
 * module and the same `MidnightBech32m` envelope the shielded half uses, so the
 * two are told apart by the codec's OWN type check and not by anything written
 * here.
 */
export interface UnshieldedPayeeAddress {
  readonly [unshieldedPayeeBrand]: true;
  /** Derived from the decode, never supplied. See `PayeeAddress.kind`. */
  readonly kind: 'unshielded';
  /** The one canonical value: what is stored, shown, pasted and compared. */
  readonly bech32: string;
  /** The network this address is FOR. Part of the string; kept for messages. */
  readonly network: NetworkName;
  /**
   * Who may spend it. Hex, 32 bytes. **A `UserAddress`, NOT a coin public key.**
   *
   * Named for what it is rather than `recipient` or `key`, because the whole
   * hazard is that a name which fits both spaces lets a value from one be
   * handed to a circuit expecting the other.
   */
  readonly userAddress: Hex;
}

/**
 * A PAYEE, WHICHEVER KIND OF MONEY THEY ARE PAID IN.
 *
 * A discriminated union rather than one widened type, so a site that reads
 * `coinPublicKey` cannot compile against a payee that has none — which is the
 * compiler doing the work `C246`'s row says nothing downstream can do for raw
 * bytes.
 */
export type Payee = PayeeAddress | UnshieldedPayeeAddress;

/** The two kinds of money a vault holds, named once. */
export type PayeeKind = Payee['kind'];

/**
 * The 32 bytes that go to a circuit and into the details commitment, for
 * either kind.
 *
 * **ONE FUNCTION RATHER THAN A TERNARY AT EVERY CALL SITE**, because every one
 * of those ternaries is a place to reach for the wrong field, and both fields
 * are `Hex` of the same length. It is exhaustive over the union: a third kind
 * would fail to compile here rather than fall through to a default.
 */
export const recipientOf = (p: Payee): Hex =>
  p.kind === 'shielded' ? p.coinPublicKey : p.userAddress;

/**
 * The way an UNSHIELDED address enters the system: parsed, checked, never
 * trusted — and the same three platform checks the shielded parse makes.
 *
 * The middle one is the one that matters here. `Bech32mCodec.decode` refuses a
 * representation whose type segment is not its own — *"Expected type addr, got
 * shield-addr"* — so **a shielded address handed to this function throws, and a
 * user address handed to `payeeAddress` throws.** Neither can be silently read
 * as the other, which is the exact confusion `C246` is about, refused by the
 * platform's own codec rather than by a check of ours.
 */
export function unshieldedPayeeAddress(
  bech32: string, network: NetworkName,
): UnshieldedPayeeAddress {
  const raw = (bech32 ?? '').trim();
  if (!raw) throw new Error('a payee address is required, and this one is empty');

  let parsed: MidnightBech32m;
  try {
    parsed = MidnightBech32m.parse(raw);
  } catch (e) {
    throw new Error(
      `"${raw}" is not a Midnight address: ${(e as Error).message}. `
      + 'A public payee address looks like mn_addr_<network>1... and carries its own checksum.');
  }

  let address: UnshieldedAddress;
  try {
    address = parsed.decode(UnshieldedAddress, network);
  } catch (e) {
    /*
     * **`(C246)` WAS PRINTED HERE, TO A CUSTOMER.** `product-copy-auditor`,
     * `S12`. It is a row number in a gitignored internal register: nothing
     * outside this repository can resolve it, and a bare code in a refusal
     * reads as a leaked stack trace to a finance buyer. The row belongs in the
     * comment above, where it is.
     *
     * The two causes stay named, because both are real and reachable: the
     * NETWORK, which is what `payeeOf` routes here can fail on, and the KIND,
     * which a direct call to this function can. What went is the vocabulary a
     * customer cannot act on.
     */
    throw new Error(
      `"${raw}" is not a public payee address for ${network}: ${(e as Error).message}. `
      + 'A public payee address starts with mn_addr_ and is for one network only. '
      + 'An mn_shield-addr_ is a private payee and cannot be paid this way. '
      + 'The money would go to an address nobody holds the key for, and nothing can bring '
      + 'it back.');
  }

  return Object.freeze({
    kind: 'unshielded',
    bech32: parsed.asString(),
    network,
    userAddress: address.hexString as Hex,
  }) as UnshieldedPayeeAddress;
}

/**
 * The one place a user address is legitimately known as bytes: a wallet we
 * hold, or a device that has just derived its own.
 *
 * **It re-parses its own output**, exactly as `payeeAddressFromKeys` does, so
 * the value returned came out of a decode like every other one and there is no
 * way to make one that skipped it.
 *
 * A NAMED FIELD AND NOT A BARE STRING, for `payeeAddressFromKeys`'s reason one
 * argument down: there is only one key here today, and the day a second arrives
 * two positional 32-byte hex strings side by side transpose silently.
 */
export function unshieldedPayeeAddressFromKeys(
  keys: { userAddress: Hex }, network: NetworkName,
): UnshieldedPayeeAddress {
  const { userAddress } = keys;
  if (!HEX32.test(userAddress ?? '')) {
    throw new Error(
      'the user address must be 32 bytes of lowercase hex; got '
      + (userAddress ? `"${userAddress}"` : 'nothing'));
  }
  /*
   * NOT CHECKED FOR BEING AN ADDRESS ANYBODY HOLDS, only for being 32 bytes —
   * and on this side nothing anywhere can check it. `Vault.compact` says so in
   * its own words: *"nobody validates this address and nobody can."* The signers
   * are the check, which is why the recipient is inside the approved leaf.
   */
  const address = new UnshieldedAddress(Buffer.from(userAddress, 'hex'));
  return unshieldedPayeeAddress(MidnightBech32m.encode(network, address).asString(), network);
}

/**
 * ONE PASTED STRING IN, THE RIGHT KIND OUT — and it is the only function that
 * should ever be reached for when a person types or pastes an address.
 *
 * **The kind is READ, never asked for.** A screen that offered "shielded or
 * public?" beside an address field would let somebody answer it wrongly for an
 * address that already says; this reads the type segment the platform put
 * there. An address of neither type is refused naming both, because the third
 * possibility — a `mn_dust_...`, say — is not a payee at all.
 */
export function payeeOf(bech32: string, network: NetworkName): Payee {
  const raw = (bech32 ?? '').trim();
  if (!raw) throw new Error('a payee address is required, and this one is empty');

  let type: string;
  try {
    type = MidnightBech32m.parse(raw).type;
  } catch (e) {
    throw new Error(
      `"${raw}" is not a Midnight address: ${(e as Error).message}. A payee address looks like `
      + 'mn_shield-addr_<network>1... (private) or mn_addr_<network>1... (public), and carries '
      + 'its own checksum.');
  }

  if (type === ShieldedAddress.codec.type) return payeeAddress(raw, network);
  if (type === UnshieldedAddress.codec.type) return unshieldedPayeeAddress(raw, network);
  /*
   * **REWRITTEN IN `S12`, BECAUSE THIS SENTENCE IS NOW SOMETHING A CUSTOMER
   * READS.** `product-copy-auditor`.
   *
   * Before this round a public address was refused by name upstream, so almost
   * nothing reached this dispatch. `wallet-payee.ts` surfaces it verbatim now
   * to whoever pasted or disclosed the address, and it said *"shield-addr,
   * private money, carrying the key that says who may READ the payment"* to an
   * employee at their own wallet screen. **The only thing they can act on is
   * which two prefixes are payable**, so that is what it says.
   */
  throw new Error(
    `"${raw}" is a Midnight ${type} address, and it is not a payee. A payee address starts `
    + 'with mn_shield-addr_ for a private payment, or mn_addr_ for a public one. '
    + 'Nothing else can receive money.');
}

/** Two addresses are the same payee when they are the same value. */
export const samePayee = (a: Payee, b: Payee): boolean => a.bech32 === b.bech32;

/**
 * What a person sees when they are asked to check an address before money moves.
 *
 * Ends AND begins are both shown, because a truncation that only shows the
 * start is confirmed by anything with the right prefix — and every address on
 * one network shares its prefix.
 */
export const shortPayee = (a: Payee): string =>
  `${a.bech32.slice(0, 18)}…${a.bech32.slice(-8)}`;

import { verify as verifySigned, addressOfVerifyingKey } from 'midnight-identity/profile/disclosure';
import type { DisclosureResponse } from 'midnight-identity/profile/disclosure';
import { payeeOf } from '../midnight/payee-address.js';
import type { Payee } from '../midnight/payee-address.js';
import type { NetworkName } from '../midnight/network.js';
import type { ChallengeStore } from './challenges.js';
import { RECEIVING_ADDRESS } from './wallet-payee-ask.js';

/**
 * **TAKING A RECEIVING ADDRESS FROM A WALLET — and every reason it might not
 * be one.** `docs/NEXT.md` X8 §2, `docs/how-money-can-be-lost.md` `C153`.
 *
 * ── WHY THIS IS ON THE SERVER AND NOT IN THE PAGE ─────────────────────────
 *
 * The screen this replaces took the address as typed text, and the field comes
 * out with it. **Replacing a text box with a button that forwards whatever the
 * wallet said would be the same door with the box hidden**: the server would
 * still be accepting an address chosen by whatever code is running in that tab.
 * So the signature is checked HERE, where the record is written, for the reason
 * `wallet-identity.ts` gives about sign-in — *a check made by the thing being
 * persuaded is not a check* — and for the reason the page cannot do it anyway:
 * verifying reaches `ledger-v9`, which is ten megabytes of WebAssembly.
 *
 * ── THE BINDINGS, AND EVERY ONE IS SOMETHING THIS DEPLOYMENT HOLDS ────────
 *
 * 1. **THE NONCE IS OURS**, issued by our own challenge store against a handle
 *    that never leaves this origin, and **spent before anything else is even
 *    looked at** — `wallet-identity.ts` argues that order, and the reason is
 *    the same: a challenge that survives being presented can be presented
 *    again.
 * 2. **THE ORIGIN IS OURS.** Configuration, never a request header. A
 *    disclosure minted for another payroll names that payroll inside the
 *    signature.
 * 3. **THE ADDRESS THAT SIGNED IS RECOMPUTED FROM THE KEY.** `payload.address`
 *    is never the authority.
 * 4. **AND THE VALUE IS ONE THE WALLET WORKED OUT, NOT ONE SOMEBODY TYPED.**
 *    See below — it is the whole point of this door and it is a refusal.
 *
 * ── WHAT THIS BUYS AND WHAT IT DOES NOT, MEASURED ─────────────────────────
 *
 * **What it buys:** nobody can put an address on a payroll record by typing it.
 * The value arrives inside a signature made by the subwallet whose address it
 * is, over a nonce this deployment issued, for this origin — *the payee
 * produces the address themselves*, holding for the first time on a door that
 * is not `acceptInvite`.
 *
 * **What it does NOT buy, said rather than left to be found:** nothing here can
 * check that the shielded address disclosed and the key that signed are one
 * person's. They cannot be compared — the signature is made by the subwallet's
 * NIGHT key and the address is its ZSWAP one, and no derivation joins them on
 * this side. `packages/identity/src/profile/disclosure.ts` says the same thing about
 * itself: *round tripping proves the encoding, never the pairing.* **The
 * pairing is guaranteed by the wallet computing both from one subwallet**, and
 * `apps/wallet/src/screens/payee-disclosure.test.tsx` is where that is held.
 *
 * **And a disclosure obtained from somebody else cannot be replayed here**,
 * because the nonce is one-use and bound to a handle that never leaves this
 * origin — but a person who approves a disclosure on a page an attacker
 * controls at OUR origin has approved it for us. That is the same exposure the
 * sign-in has and it is not narrowed here.
 */

export type PayeeFailure =
  | 'not-a-response'
  | 'stale-challenge'
  | 'unusable-key'
  | 'address-not-the-signers'
  /* The five in the middle are the wallet's own `VerdictFailure` values, passed
   * through unchanged so a refusal keeps the name the code that made it gave
   * it. Matching on the sentence instead of the name is the mistake this
   * avoids. */
  | 'wrong-schema'
  | 'origin-mismatch'
  | 'nonce-mismatch'
  | 'address-mismatch'
  | 'signature-invalid'
  | 'expired-claim'
  /* This side's. */
  | 'nothing-disclosed'
  | 'discloses-something-else'
  | 'not-worked-out-by-the-wallet'
  | 'not-a-payee-address';

export class WalletPayeeError extends Error {
  readonly code: PayeeFailure;

  constructor(code: PayeeFailure, message: string) {
    super(message);
    this.name = 'WalletPayeeError';
    this.code = code;
  }
}

/**
 * THE SHAPE CHECK, AND IT IS TOTAL — the same one `wallet-identity.ts` runs,
 * for the same reason: what arrives is JSON off a wire and nothing below may
 * throw a `TypeError` out of a property access on a caller matching by name.
 */
function asResponse(raw: unknown): DisclosureResponse {
  const nope = (): never => {
    throw new WalletPayeeError(
      'not-a-response', 'that is not something a wallet could have signed.');
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) nope();
  const body = raw as Record<string, unknown>;
  const payload = body['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) nope();
  const p = payload as Record<string, unknown>;
  if (typeof p['schema'] !== 'string' || typeof p['origin'] !== 'string'
    || typeof p['nonce'] !== 'string' || typeof p['address'] !== 'string'
    || typeof p['at'] !== 'number' || !Number.isSafeInteger(p['at'])
    || !Array.isArray(p['disclosed']) || !Array.isArray(p['declined'])) nope();
  if (typeof body['signature'] !== 'string' || typeof body['verifyingKey'] !== 'string'
    || typeof body['scheme'] !== 'string') nope();
  return raw as DisclosureResponse;
}

export interface PayeeFromWallet {
  /**
   * Parsed and rebuilt from its own string, like every other address here.
   *
   * **`Payee` IS EITHER KIND, AND THE WALLET'S STRING SAYS WHICH.** Nothing
   * here asks a person which kind of address they are handing over, because the
   * address already says. Whether the person may then be paid from a PAYROLL
   * run is a different question, answered by `movement.ts` on the payroll path
   * and not at this door.
   */
  readonly address: Payee;
  /** The subwallet that signed, as the wallet writes it. Bech32, unshielded. */
  readonly signedBy: string;
}

/**
 * **ONE ANSWER, CHECKED AGAINST FOUR THINGS WE HOLD, OR A NAMED REFUSAL.**
 *
 * `now` is passed in rather than read off the clock so a test can hold it
 * still, exactly as the wallet's own `mint` takes the moment from its caller.
 */
export async function payeeFromWallet(
  args: { handle: string; nonce: string; response: unknown },
  where: {
    readonly origin: string;
    readonly network: NetworkName;
    readonly challenges: ChallengeStore;
    readonly now?: () => number;
  },
): Promise<PayeeFromWallet> {
  const now = where.now ?? (() => Date.now());

  /*
   * **SPENT BEFORE ANYTHING ELSE IS LOOKED AT.** A malformed body refused as
   * `not-a-response` while leaving the nonce LIVE is a nonce that can be
   * presented again, which turns a one-use proof into a two-minute window.
   * `challenges.ts` makes the same argument in its own words.
   */
  const ours = await where.challenges.consume(String(args.handle ?? ''), args.nonce);
  if (!ours) {
    throw new WalletPayeeError(
      'stale-challenge',
      'this answers a request this deployment did not issue, or one that has already been '
      + 'used or has expired. Ask your wallet again.');
  }

  const response = asResponse(args.response);

  let signedBy: string;
  try {
    signedBy = addressOfVerifyingKey(response.verifyingKey, where.network);
  } catch {
    throw new WalletPayeeError(
      'unusable-key', 'the key that signed this is not one an address can be read from.');
  }

  const verdict = verifySigned(response, {
    atOrigin: where.origin,
    expectingNonce: args.nonce,
    /* The DERIVED value, so `verify`'s own address branch cannot pass by
     * agreeing with itself. The explicit comparison below is what refuses a
     * payload naming an address its own key does not produce. */
    payingAddress: signedBy,
    networkId: where.network,
    now: now(),
  });
  if (!verdict.ok) throw new WalletPayeeError(verdict.code, verdict.says);

  if (response.payload.address !== signedBy) {
    throw new WalletPayeeError(
      'address-not-the-signers',
      'this names one wallet and was signed by the owner of another. It is refused: the '
      + 'key is what says whose it is, and the two do not agree.');
  }

  /*
   * **WHAT WAS ASKED FOR AND NOTHING ELSE.** The wallet sends only what this
   * deployment named, and a response carrying more would mean payroll quietly
   * holding data it has no record of requesting. Ignoring the extra would leave
   * whoever sent it entitled to believe it had been kept. Same rule, same
   * sentence, as the sign-in's `discloses-something`.
   */
  const extra = response.payload.disclosed.filter((s) => s.about !== RECEIVING_ADDRESS);
  if (extra.length > 0) {
    throw new WalletPayeeError(
      'discloses-something-else',
      `this was asked for a receiving address and also carries ${extra.length} other `
      + 'detail(s). Nothing else was asked for, so they are refused rather than kept.');
  }

  const sent = response.payload.disclosed.find((s) => s.about === RECEIVING_ADDRESS);
  if (!sent) {
    throw new WalletPayeeError(
      'nothing-disclosed',
      'no address was sent. Declining is a normal answer in a wallet, and nothing here has '
      + 'been changed — but there is nowhere to pay you until one arrives.');
  }

  /*
   * **THE VALUE MUST BE ONE THE WALLET WORKED OUT, AND THIS IS THE WHOLE OF IT
   * IN ONE REFUSAL.** `packages/identity/src/profile/model.ts`'s third
   * assertion arm.
   *
   * `by: 'self'` means a person typed it. **That is exactly what the pasted box
   * was**, and accepting it here would leave that precedent alive with a
   * wallet's chrome around it — an address somebody typed into a field, signed,
   * and therefore harder to argue with. `by: 'issuer'` is worse: an address is
   * not a fact anybody signs on somebody else's behalf.
   *
   * **THE COST, STATED:** a wallet that computes the address correctly but
   * labels it `self` is refused. That is the intended strictness — the label is
   * the only thing on the wire that says the value came from the keys rather
   * than from a keyboard, and a recipient that ignores it is not checking
   * anything.
   */
  if (sent.asserted.by !== 'wallet') {
    throw new WalletPayeeError(
      'not-worked-out-by-the-wallet',
      'this address is marked as something somebody stated rather than something the '
      + 'wallet worked out from its own keys. An address that was typed is an address that '
      + 'can be typed wrong, or typed by somebody else, so it is refused here.');
  }
  if (sent.says.of !== 'value') {
    throw new WalletPayeeError(
      'not-a-payee-address',
      'this carries a proof about an address rather than an address. There is nothing to '
      + 'pay a proof.');
  }

  /*
   * **REBUILT FROM ITS OWN STRING RATHER THAN TRUSTED.** What arrived is text;
   * `payeeOf` is the platform's checksum, the address TYPE and the network,
   * exactly as `payeeAddress` was — it is the same decode, and the
   * rebuild-rather-than-trust rule is unchanged rather than relaxed.
   *
   * **WHAT CHANGED IS WHICH TYPES ARE PAYEES, NOT HOW HARD THEY ARE CHECKED.**
   * This line used to refuse an `mn_addr_` BY NAME. It no longer does, because
   * a company paying its own public address is a real movement and because a
   * vendor may want public settlement. **A third type is still refused naming
   * both** — `payeeOf` throws on a `mn_dust_`, which is not a payee at all.
   *
   * **A PUBLIC ADDRESS IS PAID PUBLICLY.** A payroll run pays each person in
   * the form their address is, and the screen says what a public payment puts
   * on the record wherever a person is set up to be paid that way.
   */
  let address: Payee;
  try {
    address = payeeOf(sent.says.value, where.network);
  } catch (e) {
    throw new WalletPayeeError('not-a-payee-address', (e as Error).message);
  }
  return { address, signedBy };
}

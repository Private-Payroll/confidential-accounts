import { check } from 'midnight-identity/profile/definition';
import type { AttributeDefinition, AttributeName } from 'midnight-identity/profile/definition';
import { PUBLIC_RECEIVING_ADDRESS, RECEIVING_ADDRESS, REGISTRY } from 'midnight-identity/profile/attributes';
import type { Identity } from 'midnight-identity';
import type { NetworkName } from 'midnight-identity/network';
import { ownedAddressFor } from './owned-address.js';
import type { OwnedAddress } from './owned-address.js';
import { WALLET_ACCOUNTS } from './subwallets.js';

/**
 * WHERE A DERIVED ATTRIBUTE'S VALUE ACTUALLY COMES FROM.
 * See `../profile/definition.ts`'s `Source`.
 *
 * ── THE COST OF THE SECOND SOURCE, NAMED RATHER THAN GLOSSED ─────────────
 *
 * `attributes.ts` promises that **adding an attribute is adding an entry**, and
 * `registry-open.test.ts` proves it. **That promise is about STATED attributes
 * and this file is the exception, so here is exactly how big the exception is.**
 *
 * A derived attribute is a value nobody typed, so something has to compute it,
 * and a computation is code. Adding a second derived attribute therefore adds
 * an entry in `attributes.ts` AND a line here. **What it does not add is a
 * branch anywhere else**: the screen asks whether the definition's source is
 * `derived` and never which attribute it is holding, so the approval surface,
 * the profile form and the disclosure minting are untouched by this file
 * growing. `derived-registry.test.ts` asserts the other half — that every
 * derived definition in the registry has a producer here — so a definition
 * added without one is a red test rather than a row on a screen saying the
 * wallet cannot work it out.
 *
 * ── WHY THE PRODUCER TAKES AN `OwnedAddress` AND NOT AN `Identity` ───────
 *
 * `owned-address.ts` is the only door in this app that turns a wallet account
 * into a renderable address, and what comes out already carries the OWNER — the
 * name and the slot. **The durable half.** A producer handed an identity
 * and a number could derive an address for one slot while the screen showed
 * another; handed an `OwnedAddress` there is one value and no pair to
 * disagree. The slot the screen is showing IS the slot the value came from,
 * because they are the same object.
 *
 * ── AND THE VALUE IS CHECKED AGAINST ITS OWN RULE BEFORE IT IS SENT ──────
 *
 * `derive` runs `check`, which is the same function the form runs over
 * something a person typed. **A definition's rule is not decoration for the
 * places a human is involved.** The substitution this catches is the one that
 * would cost money and would look right in every screenshot: an unshielded
 * `mn_addr_` address where a `mn_shield-addr_` one belongs. Both are addresses
 * of the same subwallet, both come out of `owned-address.ts`, and only one of
 * them can be paid — `payeeAddress()` refuses the other by name, on the far
 * side of a network hop, hours later.
 */

/** What answers one derived attribute. One line per attribute, and no more. */
export type Producer = (owned: OwnedAddress) => string;

/**
 * THE PRODUCERS. **`address` IS THE SHIELDED ONE AND ANSWERS THE RECEIVING
 * ADDRESS; `unshieldedBech32` IS THE PUBLIC ONE AND ANSWERS ONLY THE PUBLIC
 * RECEIVING ADDRESS.** Each definition's own pattern refuses the other kind, so
 * the two wired the wrong way round is a refusal in `derive` rather than a
 * comment: money with no private form is never handed a shielded address, and
 * private money never a public one.
 */
const PRODUCERS: Readonly<Record<string, Producer>> = Object.freeze({
  [RECEIVING_ADDRESS]: (owned: OwnedAddress) => owned.address.bech32,
  [PUBLIC_RECEIVING_ADDRESS]: (owned: OwnedAddress) => owned.unshieldedBech32,
});

/** Whether this wallet can answer a derived attribute at all. */
export const producerFor = (name: AttributeName): Producer | null =>
  PRODUCERS[name] ?? null;

/** Every derived attribute this build can produce. For the test that pairs
 * them with the registry, and for nothing else. */
export const DERIVED_ATTRIBUTES: readonly AttributeName[] =
  Object.freeze(Object.keys(PRODUCERS));

export type Derived =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly says: string };

/**
 * THE ONE DOOR A DERIVED VALUE COMES OUT OF, and it is total.
 *
 * Every refusal is a sentence the screen can render beside the row, because the
 * alternative — a throw — would take down an approval surface a person is
 * standing in front of, mid-disclosure, for a row that could simply have said
 * nothing will be sent for this.
 */
export function derive(definition: AttributeDefinition, owned: OwnedAddress): Derived {
  if (definition.source !== 'derived') {
    return {
      ok: false,
      says: `${definition.render.label} is not something this wallet works out — it is `
        + 'something you or somebody else states, and it is held rather than computed.',
    };
  }
  const producer = producerFor(definition.name);
  if (producer === null) {
    return {
      ok: false,
      says: `This wallet does not know how to work out ${definition.render.label.toLowerCase()}`
        + ', and it will not invent it. Nothing will be sent for this.',
    };
  }
  const checked = check(definition, producer(owned));
  if (!checked.ok) {
    /*
     * **A PRODUCED VALUE THAT FAILS ITS OWN RULE IS A DEFECT IN THIS FILE, AND
     * IT IS STILL A REFUSAL RATHER THAN A THROW.** The person is told nothing
     * is being sent for this row; what they must never be told is that the
     * value below is where their salary will go, when the rule says it is not
     * an address that can be paid.
     */
    return {
      ok: false,
      says: `This wallet worked out a ${definition.render.label.toLowerCase()} that is not `
        + `one: ${checked.says} Nothing will be sent for this.`,
    };
  }
  return { ok: true, value: checked.value };
}

/**
 * **EVERY RECEIVING ADDRESS THIS WALLET HOLDS, ONE PER ACCOUNT IT OFFERS.**
 *
 * Worked out through the same door and the same producer a receiving-address
 * disclosure uses: `ownedAddressFor` for the account, then `derive` over the
 * registry's own definition. There is no second way to turn an account into
 * the address it is paid at, so the addresses answered for here are exactly
 * the ones this wallet would have handed out. Nothing here needs the person to
 * approve anything: the keys are the ones the screen already holds.
 *
 * An account whose address cannot be worked out is left out rather than
 * guessed; the answer is then silent about it, which reads as "cannot tell".
 *
 * **THE PUBLIC ADDRESSES ARE NOT ANSWERED FOR, AND THAT IS DELIBERATE.** The
 * answer is a digest a page can test any address against. A shielded address
 * never appears on the chain, so a page can only test one it was already
 * given. A public address is on the chain for anyone to read, so a page could
 * test the answer against every public address the chain has ever shown and
 * learn which of them are this person's, in every subwallet.
 */
export function receivingAddressesOf(identity: Identity, network: NetworkName): string[] {
  const definition = REGISTRY.definitionOf(RECEIVING_ADDRESS);
  if (definition === null) return [];
  const held: string[] = [];
  for (const account of WALLET_ACCOUNTS) {
    try {
      const derived = derive(definition, ownedAddressFor(identity, account, {}, network));
      if (derived.ok) held.push(derived.value);
    } catch { /* not an address this wallet can show */ }
  }
  return held;
}

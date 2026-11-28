/*
 * What the wallet can offer for each thing a page asks for, as one row per thing: the definition, what is held, what the wallet works out itself, and the code a person carries back for a receiving address.
 */
import { PUBLIC_RECEIVING_ADDRESS, RECEIVING_ADDRESS } from 'midnight-identity/profile/attributes';
import type { Registry } from 'midnight-identity/profile/attributes';
import type { AttributeDefinition, AttributeName } from 'midnight-identity/profile/definition';
import { heldAbout } from 'midnight-identity/profile/model';
import type { Held, Profile } from 'midnight-identity/profile/model';
import { asked } from 'midnight-identity/profile/request';
import type { Wanting } from 'midnight-identity/profile/request';
/* A RENDERING of the receiving address a row is about to disclose, for the person to carry
 * back to the page that asked. It is not an input to anything derived either;
 * `midnight-identity/profile/fingerprint` says why. */
import { addressFingerprint } from 'midnight-identity/profile/fingerprint';
import type { OwnedAddress } from '../accounts/owned-address.js';
/* The producer for a DERIVED attribute, and the reason it lives beside
 * the screen rather than in the registry: `../accounts/derived.ts`. */
import { derive } from '../accounts/derived.js';
import type { Derived } from '../accounts/derived.js';

export interface Row {
  readonly attribute: AttributeName;
  readonly required: boolean;
  readonly reason: string | undefined;
  readonly definition: AttributeDefinition | null;
  readonly options: readonly Held[];
  /**
   * **WHAT THIS WALLET WORKED OUT, FOR A DERIVED ATTRIBUTE ONLY.** `null`
   * for every stated one, and a stated row's `options` are `null` here for the
   * same reason: **a row is one or the other and never both**, so there is no
   * state where a screen could show a held value beside a computed one and
   * leave a person guessing which is about to be sent.
   */
  readonly derived: Derived | null;
  /**
   * **THE CODE THE PERSON CARRIES BACK, AND WHY IT IS A FIELD RATHER
   * THAN A BRANCH IN THE RENDER.**
   *
   * `derived.ts`'s whole discipline is that this screen asks whether a
   * definition is derived and never which attribute it is holding. A code
   * belongs to the attributes money arrives at — the shielded receiving
   * address and the public one — so the question
   * *which attribute is this* is answered once, here, where the attribute is
   * already in hand, and the render below stays a render.
   *
   * `null` for every other row, including a derived row whose value was
   * refused: there is nothing about to be disclosed, so there is nothing to
   * confirm.
   */
  readonly code: string | null;
}

/**
 * What the wallet can offer for each thing asked for.
 *
 * **`owned` IS THE CHOSEN WALLET, AS ONE VALUE.** It carries the address
 * and its owner together (`owned-address.ts`), so the slot a derived
 * value is computed from is the slot the screen is showing, by being the same
 * object rather than by two call sites agreeing.
 *
 * The wallet can say where to pay a person, and it is a row rather than a kind of ask of its own: the disclosure
 * ask names the receiving address like any other attribute, and the row is filled in from the wallet the person
 * chose, never from what is held and never from what the request said. The value is not a `Held` (see `Source`, in
 * `midnight-identity/profile/definition`): an address is computed from this person's keys, so storing it would
 * record a computed fact as though somebody had asserted it, and the copy would go stale as soon as a different wallet
 * was chosen. A kind of its own could refuse to carry anything else with it; here every row is shown and approved
 * separately, and declining one is a normal answer.
 */
export const rowsFor = (request: Wanting, registry: Registry, profile: Profile, owned: OwnedAddress): readonly Row[] =>
  asked(request, registry).map(({ want, known }) => {
    const definition = known ? registry.definitionOf(want.attribute) : null;
    const isDerived = definition !== null && definition.source === 'derived';
    const derived = isDerived ? derive(definition, owned) : null;
    return {
      attribute: want.attribute,
      required: want.required,
      reason: want.reason,
      definition,
      /* NOTHING DERIVED IS EVER IN `held`, so there is nothing to offer and no
       * list to pick from. `heldAbout` would answer an empty array anyway; not
       * calling it is what says the emptiness is by construction. */
      options: definition === null || isDerived ? [] : heldAbout(profile, definition.name),
      derived,
      /* Computed from the value that is about to be sent and from
       * nothing else — the same string the receiving side will compute from the
       * same address, which is the whole of the comparison. */
      code:
        (want.attribute === RECEIVING_ADDRESS || want.attribute === PUBLIC_RECEIVING_ADDRESS) &&
        derived !== null &&
        derived.ok
          ? addressFingerprint(derived.value)
          : null
    };
  });

import { define } from './definition.js';
import type { AttributeDefinition, AttributeName } from './definition.js';

/**
 * THE VOCABULARY.
 *
 * **THIS FILE IS THE ONLY PLACE AN ATTRIBUTE IS NAMED.** Adding one is adding
 * an entry below. If adding one ever requires a line anywhere else — a form, a
 * validator, the approval screen, a `switch` — that is a defect to fix before
 * the next attribute is added, not after. `registry-open.test.ts` proves the
 * claim by doing it: a throwaway ISSUED attribute with an awkward rule, driven
 * end to end, then removed.
 *
 * WHY IT IS THIS SHORT, AND WHY THAT IS THE DECISION RATHER THAN THE ABSENCE OF
 * ONE. §9: *a vocabulary is easy to grow and impossible to shrink.* An
 * attribute that has been disclosed once cannot be un-named, because grants and
 * disclosure histories refer to it by name for ever. So the first vocabulary is
 * the three facts a payroll company actually needs to know a person by, and
 * everything else waits for something real to ask for it.
 *
 * **NO SHIPPED ATTRIBUTE ACCEPTS AN ISSUER YET, AND THAT IS SAID RATHER THAN
 * GLOSSED.** Every entry below is `selfAssertable: true, acceptedIssuers: null`
 * — nobody signs a person's own first name. The issuer half of the model is
 * therefore exercised only by the throwaway attribute in the test, which is
 * exactly what §9 asks for: *the throwaway attribute should be an ISSUED one,
 * so the issuer path is exercised before any issuer exists.* Nothing here knows
 * `self.xyz` or any other provider's name (§6, §9).
 *
 * **THE REGISTRY IS OURS, NOT THE REQUESTER'S.** §3.4. An application asks for
 * attributes by name from this list; it can never define one, extend one, or
 * attach a rule to one. Otherwise an employer defines
 * `national-insurance-number` with its own validation and its own idea of what
 * the person is agreeing to, and the wallet renders somebody else's form while
 * wearing our chrome.
 */

export const GIVEN_NAME: AttributeName = 'given-name';
export const FAMILY_NAME: AttributeName = 'family-name';
export const EMAIL: AttributeName = 'email';
/**
 * **WHERE TO PAY THIS PERSON, AND IT IS THE FIRST DERIVED ATTRIBUTE.**
 *
 * Three attributes above are facts a person STATES. This one is a fact about
 * their own KEYS: the shielded address of whichever subwallet they choose on
 * the approval screen, computed there and never stored. `definition.ts`'s
 * `Source` carries the reasoning; the entry below is what makes it an entry.
 */
export const RECEIVING_ADDRESS: AttributeName = 'receiving-address';

/*
 * A DELIBERATELY LOOSE EMAIL PATTERN, and the reason is not laziness.
 *
 * The set of strings that are deliverable email addresses is not the set any
 * regular expression describes, and a strict one refuses real addresses —
 * apostrophes, plus-addressing, new top-level domains. The only thing that
 * proves an address works is sending to it, which this wallet does not do. So
 * the pattern refuses what is certainly wrong (no `@`, whitespace, no dot in
 * the domain) and lets the person own the rest.
 */
const EMAIL_PATTERN = "[^@\\s]+@[^@\\s.]+(?:\\.[^@\\s.]+)+";

/*
 * **THE SHAPE OF A SHIELDED ADDRESS, AND WHAT THIS PATTERN IS AND IS NOT.**
 *
 * It is the same kind of guard as the email pattern above and it is worth less,
 * because the thing that actually decides whether a string is a payee address
 * is `wallet/address.ts` — the platform's Bech32m checksum, its address TYPE
 * and its network, none of which a regular expression can see. **A definition
 * is a frozen VALUE and cannot call any of them**, which is this file's oldest
 * rule and not a gap to close here.
 *
 * So what this catches is the one substitution that matters and that a pattern
 * CAN see: an `mn_addr_` unshielded address handed over where a
 * `mn_shield-addr_` one belongs. That is the exact confusion `payeeAddress()`
 * refuses by name — *a coin public key on its own is not enough to pay
 * somebody, because it does not say who may READ the payment* — and it is the
 * one a wired-up-wrong producer would make, because both are addresses of the
 * same subwallet and both look right at a glance.
 *
 * The network segment is `[a-z0-9]+` rather than the eight names, because a
 * wallet on a network this build has never heard of is not this rule's business
 * to refuse; the `1` after it is Bech32m's own separator.
 */
const SHIELDED_ADDRESS_PATTERN = 'mn_shield-addr_[a-z0-9]+1[a-z0-9]{40,}';

const DEFINITIONS: readonly AttributeDefinition[] = Object.freeze([
  define({
    name: GIVEN_NAME,
    version: 1,
    source: 'stated',
    validate: { of: 'text', minLength: 1, maxLength: 100 },
    selfAssertable: true,
    acceptedIssuers: null,
    /* A legal name and a trading name — decision 1. */
    multiple: true,
    sensitivity: 'ordinary',
    render: {
      label: 'First name',
      hint: 'The name you are called by. You can hold more than one.',
      abbreviate: 'none',
    },
    provable: [],
  }),
  define({
    name: FAMILY_NAME,
    version: 1,
    source: 'stated',
    validate: { of: 'text', minLength: 1, maxLength: 100 },
    selfAssertable: true,
    acceptedIssuers: null,
    multiple: true,
    sensitivity: 'ordinary',
    render: { label: 'Last name', hint: '', abbreviate: 'none' },
    provable: [],
  }),
  define({
    name: EMAIL,
    version: 1,
    source: 'stated',
    validate: {
      of: 'text',
      minLength: 3,
      maxLength: 254,
      pattern: EMAIL_PATTERN,
      patternSays: 'An email address looks like name@example.com.',
    },
    selfAssertable: true,
    acceptedIssuers: null,
    /* A work email and a personal one — decision 1, and the reason a grant
     * names VALUES rather than attributes (§3.2). */
    multiple: true,
    sensitivity: 'ordinary',
    render: {
      label: 'Email',
      hint: 'Where a company would write to you. You can hold more than one.',
      abbreviate: 'domain',
    },
    provable: [],
  }),
  define({
    name: RECEIVING_ADDRESS,
    version: 1,
    /*
     * DERIVED, so nobody states it and nobody issues it. `define` refuses
     * this entry outright if any of the three lines below says otherwise.
     */
    source: 'derived',
    validate: {
      of: 'text',
      minLength: 40,
      maxLength: 200,
      pattern: SHIELDED_ADDRESS_PATTERN,
      patternSays:
        'A receiving address is a shielded one — mn_shield-addr_… — because it has to say '
        + 'who may READ the payment as well as who may spend it.',
    },
    selfAssertable: false,
    acceptedIssuers: null,
    multiple: false,
    /*
     * SENSITIVE, and the approval screen reads this field rather than knowing
     * this attribute's name. It is the value that says which on-chain identity
     * a company pays — a fact the chain itself does not reveal, because the
     * payments are shielded — so it belongs beside the things that identify a
     * person to a bank rather than beside a first name.
     */
    sensitivity: 'sensitive',
    render: {
      label: 'Receiving address',
      hint: 'Where this company would pay you. It comes from the wallet you choose below, '
        + 'and it changes if you choose a different one.',
      /* The rule — both ends, never only the head. Two shielded addresses on
       * one network share their prefix, so a head-only shortening makes every
       * address on this network look like every other. */
      abbreviate: 'middle',
    },
    provable: [],
  }),
]);

/**
 * THE REGISTRY, AND THE ONE DOOR EVERY READER GOES THROUGH.
 *
 * It is a value rather than a module-level `Map` so that a test can build a
 * SECOND registry with an extra entry and drive the whole product through it
 * without mutating anything — which is what makes §3.4's proof possible at all.
 * Every function that needs a definition takes a `Registry`; nothing imports
 * `DEFINITIONS` directly.
 */
export interface Registry {
  /** In the order a form shows them. */
  readonly all: readonly AttributeDefinition[];
  /** `null` for a name this vocabulary does not know — never a throw at a
   * boundary a requester controls, and never a guess. */
  definitionOf(name: AttributeName): AttributeDefinition | null;
  knows(name: AttributeName): boolean;
}

export function registryOf(definitions: readonly AttributeDefinition[]): Registry {
  const byName = new Map<string, AttributeDefinition>();
  for (const definition of definitions) {
    const existing = byName.get(definition.name);
    if (existing) {
      throw new Error(
        `'${definition.name}' is defined twice in one registry (versions `
        + `${existing.version} and ${definition.version}). A registry holds ONE definition `
        + 'per name; a new version REPLACES the entry and the values already stored under '
        + 'the old one stay readable by the version they record.');
    }
    byName.set(definition.name, definition);
  }
  const all = Object.freeze([...definitions]);
  return Object.freeze({
    all,
    definitionOf: (name: AttributeName) => byName.get(name) ?? null,
    knows: (name: AttributeName) => byName.has(name),
  });
}

/** The vocabulary this wallet ships with. */
export const REGISTRY: Registry = registryOf(DEFINITIONS);

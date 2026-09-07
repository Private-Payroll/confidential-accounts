/**
 * WHAT AN ATTRIBUTE IS, AND WHY IT IS DATA.
 *
 * Decided 21 Aug: *adding an attribute later — with rules of its own — may
 * never be a rewrite.* This file is the machinery that makes that true, and
 * `attributes.ts` beside it is the only place an attribute is named.
 *
 * THE RULE, RESTATED AS A THING A READER CAN CHECK: adding an attribute is
 * adding an entry. If adding one required touching a `switch`, an `if`, a form
 * component or the approval screen, the registry would not be doing its job.
 * `registry-open.test.ts` proves it by adding a throwaway attribute with an
 * awkward rule — an ISSUED one, so the issuer path is exercised before any
 * issuer exists — and driving it end to end.
 *
 * SO EVERY RULE AN ATTRIBUTE HAS IS A VALUE HERE, NEVER A FUNCTION AND NEVER A
 * BRANCH. That is the whole design and it costs something worth naming: a rule
 * this vocabulary cannot express cannot be added without changing this file.
 * That is the RIGHT cost — a new rule SHAPE is a decision, and it should be one
 * somebody makes on purpose, in one place, with a version. A rule that arrives
 * as a callback is a rule no reader can enumerate and no screen can render.
 *
 * **A SECOND SOURCE, AND IT IS A NEW RULE SHAPE RATHER THAN A NEW
 * ATTRIBUTE.** `source` below is the first field added to this vocabulary since
 * it was written, and the header above says what that costs: *a new rule SHAPE
 * is a decision, and it should be one somebody makes on purpose, in one place,
 * with a version.* This is that decision, made on purpose and written down.
 *
 * **WHAT FORCED IT: a receiving address is neither stated nor issued.** Every
 * field here answers *who may say this* — `selfAssertable` for the person,
 * `acceptedIssuers` for somebody else — and a payee address is answered by
 * NEITHER. It is computed from the person's own keys, per subwallet, and it
 * changes when they pick a different one. Storing it in `held` would record a
 * COMPUTED fact as though somebody had asserted it, and `define` would have had
 * to be lied to (`selfAssertable: true`) to let it in at all. The design poses the
 * question and this is the position taken.
 *
 * `kind` IS NOT A SEPARATE FIELD, AND THAT IS DELIBERATE. §3.4 lists `kind` and
 * `validate` side by side. Two fields that must agree are two fields that can
 * disagree, and this project has paid for that shape twice — and this is what
 * disagreement about which thing is which costs, and `saveSubwalletName` and
 * `saveLastUsedWallet` disagreeing about what an account is was the same
 * disease one layer down. So `kind` is READ OFF the rule (`kindOf`), the rule
 * carries the discriminant, and there is no state where the two differ.
 */

/** The names this vocabulary knows. Never a free string — §3.3, §6. */
export type AttributeName = string & { readonly __attribute?: never };

/**
 * A predicate a zero-knowledge proof could answer later — §3.3, §3.2c.
 *
 * These are NOT built this change and nothing proves anything. They are in the
 * definition now because an issuer usually sends a CLAIM about an attribute
 * (`over-18: true`) rather than the attribute itself, and the day that claim
 * comes from Midnight's own proving rather than a provider's signature, the
 * shape must not move again.
 */
export type PredicateName = string & { readonly __predicate?: never };

/**
 * WHAT A RULE CAN SAY. The discriminant `of` is also the attribute's KIND.
 *
 * `pattern` is a source string rather than a `RegExp` because a definition is
 * a frozen value that a test compares, a screen renders and — one day — a
 * sealed blob carries. A live `RegExp` is none of those things.
 *
 * IT IS OUR PATTERN AND NEVER THE REQUESTER'S. §3.4: an application asks for
 * attributes BY NAME and can never define one, extend one, or attach a rule to
 * one. Nothing in this module ever compiles a pattern that arrived over a wire.
 */
export type Rule =
  | {
    readonly of: 'text';
    readonly minLength: number;
    readonly maxLength: number;
    /** Anchored by `check` — a rule that matches part of a string is not a rule. */
    readonly pattern?: string;
    /** What the pattern means, in the person's language. Shown when it fails. */
    readonly patternSays?: string;
  }
  | {
    readonly of: 'date';
    /** ISO `YYYY-MM-DD`, inclusive. */
    readonly earliest?: string;
    readonly latest?: string;
  }
  | {
    readonly of: 'enum';
    readonly members: readonly { readonly value: string; readonly label: string }[];
  }
  | {
    readonly of: 'number';
    readonly min?: number;
    readonly max?: number;
    readonly integer?: boolean;
  };

export type Kind = Rule['of'];

/**
 * HOW SENSITIVE, WHICH IS A FACT ABOUT THE APPROVAL SCREEN AND NOT ABOUT TASTE.
 *
 * `ordinary` — a name, a label. `sensitive` — a thing that identifies a person
 * to a state or a bank. The approval screen treats the two differently and
 * reads this field to know which; it does not know any attribute by name.
 */
export type Sensitivity = 'ordinary' | 'sensitive';

/**
 * **WHERE A VALUE MAY COME FROM AT ALL.**
 *
 * `stated` — the person types it or an issuer signs it, and what they said is
 * kept in `profile.held`. Every attribute shipped before then is one of these,
 * and `selfAssertable` and `acceptedIssuers` are the whole of who may speak.
 *
 * `derived` — **the wallet computes it from the person's own keys, at the
 * moment of asking, from the subwallet they chose on the screen.** Nobody
 * states it, nobody signs it, and **it is never in `held`**: there is no fact
 * to store, because the answer is a function of a choice made per disclosure.
 * A copy in `held` would be a value that could go stale against the keys it
 * came from — the one failure this whole file is written against, arriving as
 * a stored fact rather than as a disagreeing pair of fields.
 *
 * **THIS IS A FACT ABOUT THE ATTRIBUTE AND NOT A FUNCTION**, which is the
 * file's oldest rule. The producer is code and lives with the screen that has
 * an identity to derive from (`app/derived.ts`); what lives HERE is the one
 * value that says a producer is what answers this, and `define` refuses a
 * definition whose source and whose permissions disagree.
 */
export type Source = 'stated' | 'derived';

/** How a value is shown, and how it is shortened when there is no room. */
export interface Render {
  /** The person's word for the attribute. */
  readonly label: string;
  /** One sentence under the field. May be empty. */
  readonly hint: string;
  /**
   * Shortening, by NAME rather than by a function — the same reason as `Rule`.
   *   `none`    show it whole
   *   `middle`  first and last few characters, both ends (the rule)
   *   `domain`  an email: the local part is initials, the domain stays
   */
  readonly abbreviate: 'none' | 'middle' | 'domain';
}

/**
 * ONE ATTRIBUTE'S DEFINITION. §3.4.
 *
 * VERSIONED, AND NEVER EDITED IN PLACE. A definition is versioned because a
 * grant made under v1's rules must never silently become a grant under v2's.
 * Deciding later that `given-name` may not contain digits mints `version: 2`
 * and leaves every value already stored under v1 READABLE rather than
 * retroactively invalid. Editing one in place is how a stored fact quietly
 * stops meaning what the person agreed to.
 *
 * **VALUES ARE NOT VERSIONED AND PEOPLE EDIT THEIR OWN FACTS FREELY** — §3.2b,
 * and the two are constantly confused. Nothing here is about a person's name.
 */
export interface AttributeDefinition {
  readonly name: AttributeName;
  readonly version: number;
  /**
   * **STATED BY SOMEBODY, OR DERIVED FROM THE PERSON'S OWN KEYS.** See
   * `Source`. It decides which of the two fields below mean anything: a
   * `derived` attribute is stated by nobody, so both of them are the values
   * that say so, and `define` refuses any other combination rather than
   * leaving a definition that half-claims to be typeable.
   */
  readonly source: Source;
  /** Read off `validate`, so the two can never disagree. */
  readonly kind: Kind;
  readonly validate: Rule;
  /**
   * FALSE FOR ANYTHING ONLY AN ISSUER MAY STATE. A person may type their own
   * name; a person may not type *not on a sanctions list*. When this is false
   * the form offers no field at all — which is the registry doing its job:
   * the form has no idea why, it reads the flag.
   */
  readonly selfAssertable: boolean;
  /**
   * Who may issue a record about this. `null` means NOBODY — this attribute is
   * self-asserted only. `'any'` means the wallet does not restrict it and the
   * person is told who signed. A list restricts it to those identifiers.
   *
   * `null` AND AN EMPTY LIST ARE NOT THE SAME VALUE and both are reachable, so
   * they are two values rather than one, which is a rule about exactly
   * this. `null`: no issuer is meaningful here. `[]`: issuers are meaningful
   * and none is accepted yet, which is where `self.xyz` will land.
   */
  readonly acceptedIssuers: readonly string[] | 'any' | null;
  /** May a person hold more than one value? A work email and a personal one. */
  readonly multiple: boolean;
  readonly sensitivity: Sensitivity;
  readonly render: Render;
  readonly provable: readonly PredicateName[];
}

/** What a definition can be wrong about, named rather than described. */
export type DefinitionFailure =
  | 'name-not-in-vocabulary'
  | 'definition-malformed';

export class RegistryError extends Error {
  readonly code: DefinitionFailure;
  constructor(code: DefinitionFailure, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

/** What a definition looks like before `kind` is filled in from the rule. */
export type Definition = Omit<AttributeDefinition, 'kind'>;

/**
 * THE ONLY WAY TO MAKE A DEFINITION, so `kind` is never written by hand.
 *
 * It also refuses a definition that contradicts itself at the moment it is
 * written rather than at the moment somebody types into it: an attribute that
 * neither the person nor any issuer may state holds nothing and would render an
 * empty field for ever.
 */
export function define(definition: Definition): AttributeDefinition {
  if (!/^[a-z][a-z0-9-]*$/u.test(definition.name)) {
    throw new RegistryError(
      'definition-malformed',
      `an attribute name is lower-case words joined by hyphens; got '${definition.name}'.`);
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new RegistryError(
      'definition-malformed',
      `'${definition.name}' must carry a version of 1 or more; got ${definition.version}.`);
  }
  if (definition.source === 'derived') {
    /*
     * **A DERIVED ATTRIBUTE IS STATED BY NOBODY, AND THAT IS CHECKED
     * RATHER THAN TRUSTED.**
     *
     * `selfAssertable: true` on one of these would put a text box on the
     * approval screen for a value the person's own keys already decide — and
     * whatever they typed into it would be sent as though the wallet had
     * computed it. An issuer is the same fault with a signature on it. And
     * `multiple` asks how many of a stored thing are held, which is a question
     * about `held`; nothing derived is ever in there.
     *
     * The refusal below — *nobody may state it* — is the OPPOSITE rule for a
     * stated attribute, and firing it here would refuse the very shape this
     * source exists to allow. So the two are one branch and not two overlapping
     * conditions that have to be kept out of each other's way.
     */
    if (definition.selfAssertable || definition.acceptedIssuers !== null
      || definition.multiple) {
      throw new RegistryError(
        'definition-malformed',
        `'${definition.name}' is derived from this person's own keys, so nobody states it `
        + 'and nobody issues it: it is not self-assertable, accepts no issuer, and holds no '
        + 'second value. A derived attribute that claims otherwise would put a field on a '
        + 'screen for a value nothing typed there could change.');
    }
  } else if (!definition.selfAssertable
    && (definition.acceptedIssuers === null
      || (Array.isArray(definition.acceptedIssuers) && definition.acceptedIssuers.length === 0))) {
    throw new RegistryError(
      'definition-malformed',
      `'${definition.name}' can never hold anything: nobody may state it. Either it is `
      + 'self-assertable or somebody may issue it.');
  }
  if (definition.validate.of === 'enum' && definition.validate.members.length === 0) {
    throw new RegistryError(
      'definition-malformed', `'${definition.name}' is an enum with no members.`);
  }
  if (definition.validate.of === 'text' && definition.validate.pattern !== undefined) {
    /* Compiled ONCE, here, so a malformed pattern is a failure at start-up and
     * never a throw inside a keystroke handler. */
    try {
      // eslint-disable-next-line no-new
      new RegExp(definition.validate.pattern, 'u');
    } catch {
      throw new RegistryError(
        'definition-malformed', `'${definition.name}' carries a pattern that is not one.`);
    }
  }
  return Object.freeze({ ...definition, kind: definition.validate.of });
}

/** The kind, read off the rule. There is no second copy to disagree with. */
export const kindOf = (definition: AttributeDefinition): Kind => definition.validate.of;

/* ---------------- checking a typed value against a rule ---------------- */

/**
 * WHAT A CHECK SAYS. Not a boolean: the person has to be told what is wrong in
 * their own language, and the definition is what supplies the words.
 */
export type Check =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly says: string };

const dateLooksRight = (text: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const at = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === text;
};

/**
 * ONE FUNCTION FOR EVERY ATTRIBUTE THERE WILL EVER BE.
 *
 * It branches on the RULE's shape — four arms, one per kind — and never on an
 * attribute's name. Adding an attribute adds no arm. Adding a KIND does, and
 * that is the deliberate cost named in the header.
 */
export function check(definition: AttributeDefinition, typed: string): Check {
  const rule = definition.validate;
  const value = typed.normalize('NFC').trim();
  if (value === '') return { ok: false, says: `${definition.render.label} cannot be empty.` };

  switch (rule.of) {
    case 'text': {
      if (value.length < rule.minLength) {
        return {
          ok: false,
          says: `${definition.render.label} needs at least ${rule.minLength} `
            + `character${rule.minLength === 1 ? '' : 's'}.`,
        };
      }
      if (value.length > rule.maxLength) {
        return {
          ok: false,
          says: `${definition.render.label} is at most ${rule.maxLength} characters; `
            + `that is ${value.length}.`,
        };
      }
      if (rule.pattern !== undefined && !new RegExp(`^(?:${rule.pattern})$`, 'u').test(value)) {
        return {
          ok: false,
          says: rule.patternSays ?? `That is not a ${definition.render.label.toLowerCase()}.`,
        };
      }
      return { ok: true, value };
    }
    case 'date': {
      if (!dateLooksRight(value)) {
        return { ok: false, says: `${definition.render.label} is a date, as 2001-04-30.` };
      }
      if (rule.earliest !== undefined && value < rule.earliest) {
        return { ok: false, says: `${definition.render.label} cannot be before ${rule.earliest}.` };
      }
      if (rule.latest !== undefined && value > rule.latest) {
        return { ok: false, says: `${definition.render.label} cannot be after ${rule.latest}.` };
      }
      return { ok: true, value };
    }
    case 'enum': {
      const member = rule.members.find((m) => m.value === value);
      if (!member) {
        return {
          ok: false,
          says: `${definition.render.label} is one of: `
            + `${rule.members.map((m) => m.label).join(', ')}.`,
        };
      }
      return { ok: true, value: member.value };
    }
    case 'number': {
      if (!/^-?\d+(?:\.\d+)?$/u.test(value)) {
        return { ok: false, says: `${definition.render.label} is a number.` };
      }
      const n = Number(value);
      if (rule.integer === true && !Number.isInteger(n)) {
        return { ok: false, says: `${definition.render.label} is a whole number.` };
      }
      if (rule.min !== undefined && n < rule.min) {
        return { ok: false, says: `${definition.render.label} is at least ${rule.min}.` };
      }
      if (rule.max !== undefined && n > rule.max) {
        return { ok: false, says: `${definition.render.label} is at most ${rule.max}.` };
      }
      return { ok: true, value };
    }
    default: {
      /* Exhaustive: a new kind makes this line a type error rather than a
       * silent acceptance. `never` is the check. */
      const unreachable: never = rule;
      return { ok: false, says: String(unreachable) };
    }
  }
}

/**
 * HOW A VALUE IS SHOWN WHEN THERE IS NO ROOM — read off `render.abbreviate`.
 *
 * Both ends, never only the head: the rule, the same one `shortPayee` and
 * `shortUnshielded` already apply to addresses. A shortening that keeps only
 * the start of a string lets two different strings look identical.
 */
export function abbreviate(definition: AttributeDefinition, value: string): string {
  switch (definition.render.abbreviate) {
    case 'none': return value;
    case 'middle':
      return value.length <= 12 ? value : `${value.slice(0, 5)}…${value.slice(-5)}`;
    case 'domain': {
      const at = value.lastIndexOf('@');
      if (at <= 0) return value;
      const local = value.slice(0, at);
      const shown = local.length <= 2 ? local : `${local[0] ?? ''}…${local[local.length - 1] ?? ''}`;
      return `${shown}${value.slice(at)}`;
    }
    default: return value;
  }
}

/* Attribute definitions as plain data, so adding an attribute is adding an entry in `attributes.ts`, never a branch.
 * A rule this vocabulary cannot express needs a change here, made on purpose and versioned. */

/** An attribute's name, as the vocabulary in `attributes.ts` knows it. */
export type AttributeName = string & { readonly __attribute?: never };

/** A predicate a zero-knowledge proof could answer about an attribute; none is proved yet. */
export type PredicateName = string & { readonly __predicate?: never };

/** What a rule can say; its `of` is also the attribute's kind. The pattern is ours and never a requester's:
 * nothing here compiles a pattern that arrived over a wire. */
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

/** How sensitive a value is; the approval screen treats `sensitive` values apart, by this field and never by name. */
export type Sensitivity = 'ordinary' | 'sensitive';

/** Where a value comes from: `stated` by the person or an issuer and kept in `held`, or `derived` from the person's
 * own keys when asked, and never stored, so it cannot go stale against them. */
export type Source = 'stated' | 'derived';

/** How a value is shown, and how it is shortened when there is no room. */
export interface Render {
  /** The person's word for the attribute. */
  readonly label: string;
  /** One sentence under the field. May be empty. */
  readonly hint: string;
  /** How a value is shortened: `none`, `middle` (both ends kept) or `domain` (an email's local part shortened). */
  readonly abbreviate: 'none' | 'middle' | 'domain';
}

/** One attribute's definition. A changed rule mints a new version, so values stored under the old one stay readable. */
export interface AttributeDefinition {
  readonly name: AttributeName;
  readonly version: number;
  /** Stated by somebody, or derived from the person's own keys; `define` refuses a derived one anybody may state. */
  readonly source: Source;
  /** Read off `validate`, so the two can never disagree. */
  readonly kind: Kind;
  readonly validate: Rule;
  /** False for anything only an issuer may state; the form then offers no field for it. */
  readonly selfAssertable: boolean;
  /** Who may issue a record about this: `null` for nobody, `'any'` for anyone (the person is told who signed), or a
   * list. `[]` is not `null`: issuers are meaningful here and none is accepted yet. */
  readonly acceptedIssuers: readonly string[] | 'any' | null;
  /** May a person hold more than one value? A work email and a personal one. */
  readonly multiple: boolean;
  readonly sensitivity: Sensitivity;
  readonly render: Render;
  readonly provable: readonly PredicateName[];
}

/** What a definition can be wrong about, named rather than described. */
export type DefinitionFailure = 'name-not-in-vocabulary' | 'definition-malformed';

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

/** The only way to make a definition, so `kind` is never written by hand; it refuses one that contradicts itself. */
export function define(definition: Definition): AttributeDefinition {
  if (!/^[a-z][a-z0-9-]*$/u.test(definition.name)) {
    throw new RegistryError(
      'definition-malformed',
      `an attribute name is lower-case words joined by hyphens; got '${definition.name}'.`
    );
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new RegistryError(
      'definition-malformed',
      `'${definition.name}' must carry a version of 1 or more; got ${definition.version}.`
    );
  }
  if (definition.source === 'derived') {
    /* Stated by nobody, and checked: a typed or issued value would be sent as though the wallet had computed it,
     * and nothing derived is ever in `held` to hold more than one of. */
    if (definition.selfAssertable || definition.acceptedIssuers !== null || definition.multiple) {
      throw new RegistryError(
        'definition-malformed',
        `'${definition.name}' is derived from this person's own keys, so nobody states it ` +
          'and nobody issues it: it is not self-assertable, accepts no issuer, and holds no ' +
          'second value. A derived attribute that claims otherwise would put a field on a ' +
          'screen for a value nothing typed there could change.'
      );
    }
  } else if (
    !definition.selfAssertable &&
    (definition.acceptedIssuers === null ||
      (Array.isArray(definition.acceptedIssuers) && definition.acceptedIssuers.length === 0))
  ) {
    throw new RegistryError(
      'definition-malformed',
      `'${definition.name}' can never hold anything: nobody may state it. Either it is ` +
        'self-assertable or somebody may issue it.'
    );
  }
  if (definition.validate.of === 'enum' && definition.validate.members.length === 0) {
    throw new RegistryError('definition-malformed', `'${definition.name}' is an enum with no members.`);
  }
  if (definition.validate.of === 'text' && definition.validate.pattern !== undefined) {
    /* Compiled ONCE, here, so a malformed pattern is a failure at start-up and
     * never a throw inside a keystroke handler. */
    try {
      new RegExp(definition.validate.pattern, 'u');
    } catch {
      throw new RegistryError('definition-malformed', `'${definition.name}' carries a pattern that is not one.`);
    }
  }
  return Object.freeze({ ...definition, kind: definition.validate.of });
}

/** The kind, read off the rule. There is no second copy to disagree with. */
export const kindOf = (definition: AttributeDefinition): Kind => definition.validate.of;

/** What a check says: the value, or what is wrong in the person's own words. */
export type Check = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly says: string };

const dateLooksRight = (text: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const at = Date.parse(text); // a date alone is read as midnight UTC
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === text;
};

/** Checks a typed value against its definition's rule, branching on the rule's kind, never on an attribute's name. */
export function check(definition: AttributeDefinition, typed: string): Check {
  const rule = definition.validate;
  const value = typed.normalize('NFC').trim();
  if (value === '') return { ok: false, says: `${definition.render.label} cannot be empty.` };

  switch (rule.of) {
    case 'text': {
      if (value.length < rule.minLength) {
        return {
          ok: false,
          says:
            `${definition.render.label} needs at least ${rule.minLength} ` +
            `character${rule.minLength === 1 ? '' : 's'}.`
        };
      }
      if (value.length > rule.maxLength) {
        return {
          ok: false,
          says: `${definition.render.label} is at most ${rule.maxLength} characters; ` + `that is ${value.length}.`
        };
      }
      if (rule.pattern !== undefined && !new RegExp(`^(?:${rule.pattern})$`, 'u').test(value)) {
        return {
          ok: false,
          says: rule.patternSays ?? `That is not a ${definition.render.label.toLowerCase()}.`
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
          says: `${definition.render.label} is one of: ` + `${rule.members.map((m) => m.label).join(', ')}.`
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

/** Shortens a value as `render.abbreviate` says, keeping both ends so two different values never look identical. */
export function abbreviate(definition: AttributeDefinition, value: string): string {
  switch (definition.render.abbreviate) {
    case 'none':
      return value;
    case 'middle':
      return value.length <= 12 ? value : `${value.slice(0, 5)}…${value.slice(-5)}`;
    case 'domain': {
      const at = value.lastIndexOf('@');
      if (at <= 0) return value;
      const local = value.slice(0, at);
      const shown = local.length <= 2 ? local : `${local[0] ?? ''}…${local[local.length - 1] ?? ''}`;
      return `${shown}${value.slice(at)}`;
    }
    default:
      return value;
  }
}

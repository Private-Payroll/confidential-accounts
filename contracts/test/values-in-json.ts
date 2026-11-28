/**
 * The values a compiled contract takes and returns, written as JSON and read back: bytes as `0x` and their hex,
 * numbers as their digits and `n`, booleans, lists and records as themselves. Also the fixed inputs a derivation
 * is run on, made from each argument's compiled type, so the same type always gets the same value in each set.
 */

/** A type as a compiled contract's `contract-info.json` describes it, its largest values kept as digits. */
export type CompiledType =
  | { readonly 'type-name': 'Bytes'; readonly length: number }
  | { readonly 'type-name': 'Uint'; readonly maxval: string }
  | { readonly 'type-name': 'Field' }
  | { readonly 'type-name': 'Boolean' }
  | { readonly 'type-name': 'Vector'; readonly length: number; readonly type: CompiledType }
  | {
      readonly 'type-name': 'Struct';
      readonly name: string;
      readonly elements: readonly { readonly name: string; readonly type: CompiledType }[];
    };

/** A value as the record writes it. */
export type JsonValue = string | boolean | readonly JsonValue[] | { readonly [k: string]: JsonValue };

const hexOf = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Writes a value a compiled contract took or returned; refuses anything a contract never hands back. */
export function toJson(value: unknown): JsonValue {
  if (value instanceof Uint8Array) return `0x${hexOf(value)}`;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  throw new Error(`a compiled contract hands back no value like ${String(value)}`);
}

/** Reads a value back as the compiled contract takes it. */
export function fromJson(value: JsonValue): unknown {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^0x(?:[0-9a-f]{2})*$/u.test(value))
      return Uint8Array.from(value.slice(2).match(/../gu) ?? [], (x) => Number.parseInt(x, 16));
    if (/^[0-9]+n$/u.test(value)) return BigInt(value.slice(0, -1));
    throw new Error(`the record holds "${value}" where a value is written as 0x and hex, or as digits and n`);
  }
  if (Array.isArray(value)) return value.map(fromJson);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromJson(v)]));
}

/**
 * The two fixed input sets every derivation is run on. The first: numbers small and falling from the first argument
 * to the last, flags by the seed, and bytes ending in a zero byte, so thirty-two of them read as a field element stay
 * inside the field. The second reaches the other side of each branch and range: every flag flipped, every number at
 * zero or at its largest value in turn, and bytes whose last byte is not zero.
 */
export const INPUT_SETS = [1, 2] as const;
export type InputSet = (typeof INPUT_SETS)[number];

/** The fixed value of a type for one seed in one input set: the same type, seed and set always give the same value. */
export function fixedValueOf(type: CompiledType, seed: number, set: InputSet): unknown {
  switch (type['type-name']) {
    case 'Bytes':
      return Uint8Array.from({ length: type.length }, (_, i) => {
        const b = (seed * 31 + i * 7 + 1) & 0xff;
        if (i < type.length - 1) return b;
        return set === 1 ? 0 : b | 0x80;
      });
    case 'Uint':
      return set === 1 ? BigInt(seed) % (BigInt(type.maxval) + 1n) : seed % 2 === 1 ? BigInt(type.maxval) : 0n;
    case 'Field':
      return set === 1 ? BigInt(seed) * 1_000_003n : BigInt(seed) * 7_919n + 1n;
    case 'Boolean':
      return (seed % 2 === 1) === (set === 1);
    case 'Vector':
      return Array.from({ length: type.length }, (_, i) => fixedValueOf(type.type, seed * 7 + i + 1, set));
    case 'Struct':
      return Object.fromEntries(type.elements.map((e, i) => [e.name, fixedValueOf(e.type, seed * 5 + i + 1, set)]));
  }
}

/** The fixed inputs of a circuit's arguments in one set, seeded from the last argument up. */
export const fixedInputsOf = (types: readonly CompiledType[], set: InputSet): JsonValue[] =>
  types.map((t, i) => toJson(fixedValueOf(t, types.length - i, set)));

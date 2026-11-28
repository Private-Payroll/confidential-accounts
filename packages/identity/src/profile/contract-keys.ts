/**
 * **A CONTRACT'S VERIFIER KEYS: WHAT A WRITE OF ONE MUST BE, WHETHER A CONTRACT
 * CARRIES THE KEYS A BUILD PRODUCED, AND THE ONE UPDATE THAT FINISHES CREATING
 * A COMPANY'S ACCOUNT.**
 *
 * One module for the wallet, the page and the service. A key is what a
 * contract checks a proof against, so a contract carrying another key under a
 * circuit's name accepts proofs of another statement under that name: these
 * are the checks that say whether it does, and they are written once.
 *
 * **THIS FILE LOADS NO WEBASSEMBLY.** The ledger's classes are handed in by the
 * caller, so the same code runs in the wallet, in a browser worker, on the
 * service and in a test.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import {
  RELEASED_VERSIONS,
  expectedKeysOf,
  type KeySlot,
  type ReleasedContract,
  type ReleasedVersion
} from '../wallet/released-versions.js';

/** One reason a verifier-key write may not be built. Machine-readable, so a door prints it and a test names it. */
export interface VerifierKeyRefusal {
  code: 'unnamed-verifier-key-operation' | 'empty-verifier-key' | 'unknown-verifier-key-version';
  why: string;
}

/** One entry point whose verifier key an update writes. */
export interface VerifierKeyWrite {
  /** The entry-point name exactly as the contract carries it. */
  operation: string;
  /** The ledger's operation version, of which it has exactly two. */
  version: 'v3' | 'v4';
  /**
   * The verifier key exactly as the built artefact holds it, header included.
   * The ledger strips the header on the way in and hands back the file's bytes,
   * header and all, when the operation is read, so the file is what is compared.
   */
  verifierKey: Uint8Array;
}

/**
 * **WHAT IS REFUSED ABOUT A VERIFIER KEY BEFORE ANY UPDATE IS BUILT**: an
 * unnamed entry point, empty bytes, and a version the ledger does not have.
 * Whether the bytes are this build's is `verifierKeysMatch`'s question.
 */
export function verifierKeyRefusals(writes: readonly VerifierKeyWrite[]): VerifierKeyRefusal[] {
  const out: VerifierKeyRefusal[] = [];
  for (const [i, w] of writes.entries()) {
    if (typeof w?.operation !== 'string' || w.operation.trim() === '') {
      out.push({
        code: 'unnamed-verifier-key-operation',
        why:
          `verifier-key write [${i}] names no entry point. A key written at an entry point ` +
          'nobody named is a key nothing can read back or compare.'
      });
    }
    if (!(w?.verifierKey instanceof Uint8Array) || w.verifierKey.length === 0) {
      out.push({
        code: 'empty-verifier-key',
        why:
          `verifier-key write [${i}] ("${String(w?.operation)}") carries no key bytes. This ` +
          'must be the `.verifier` artefact EXACTLY as it sits on disk, header and all — ' +
          'measured: that is what the chain hands back, not the header-stripped form the ' +
          'runtime constructor is handed.'
      });
    }
    if (w?.version !== 'v3' && w?.version !== 'v4') {
      out.push({
        code: 'unknown-verifier-key-version',
        why:
          `verifier-key write [${i}] ("${String(w?.operation)}") names version ` +
          `"${String(w?.version)}", and the runtime has exactly two: "v3" and "v4". They are ` +
          'not labels — each one requires its own header tag on the bytes and the constructor ' +
          'throws on a mismatch.'
      });
    }
  }
  return out;
}

/**
 * One verifier key in one of an operation's two slots, as the ledger hands it
 * back: the key file's own bytes, header included. `v2` holds a key compiled
 * against the older proving system and `v3` one compiled against the newer; the
 * ledger checks each proof against the slot of the proof's own version, so a
 * key in either slot is live.
 */
export interface SlotKey {
  readonly slot: KeySlot;
  readonly key: Uint8Array;
}

/** One entry point and its verifier keys, as a contract carries it. */
export interface OnChainOperation {
  name: string;
  /**
   * The one key the ledger's own `verifierKey` reads: the `v3` slot's, or the
   * `v2` slot's when `v3` is empty. Never enough to judge an operation by,
   * since the other slot does not show here; `slots` holds both.
   */
  verifierKey: Uint8Array;
  /** Every filled slot, read from the operation's serialized bytes. */
  slots: readonly SlotKey[];
}

export type OperationsRead =
  | { state: 'read'; address: string; operations: OnChainOperation[] }
  | { state: 'unreadable'; address: string; why: string; entryPoint?: string };

const OPERATION_HEADER = new TextEncoder().encode('midnight:contract-operation[v6]:');
const SLOT_HEADER: Readonly<Record<KeySlot, Uint8Array>> = {
  v2: new TextEncoder().encode('midnight:verifier-key[v6]:'),
  v3: new TextEncoder().encode('midnight:verifier-key[v7]:')
};
const SLOT_ORDER: readonly KeySlot[] = ['v2', 'v3'];

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const joined = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/**
 * A compact length prefix as the ledger writes one: its value and how many
 * bytes it took, or null. Only the one-, two- and four-byte forms are read; a
 * key never needs the long form, so meeting it is a refusal.
 */
function lengthAt(b: Uint8Array, at: number): { value: number; size: number } | null {
  const first = b[at];
  if (first === undefined) return null;
  const size = [1, 2, 4][first & 0b11];
  if (size === undefined || at + size > b.length) return null;
  let value = 0;
  for (let i = size - 1; i >= 0; i -= 1) value = value * 256 + b[at + i]!;
  return { value: Math.floor(value / 4), size };
}

/**
 * **EVERY FILLED KEY SLOT OF ONE OPERATION, FROM ITS SERIALIZED BYTES**, each
 * as the key file it was written from; null for bytes not laid out as an
 * operation. The bytes are the operation's header, then each slot in turn, `v2`
 * and `v3`, as a one-byte present flag and, when present, the key's length and
 * body; then the operation's circuit description: when its flag says it is
 * absent nothing may follow, and when present it is not read.
 */
export function slotsOfOperationBytes(bytes: Uint8Array): SlotKey[] | null {
  if (!sameBytes(bytes.slice(0, OPERATION_HEADER.length), OPERATION_HEADER)) return null;
  let at = OPERATION_HEADER.length;
  const slots: SlotKey[] = [];
  for (const slot of SLOT_ORDER) {
    const present = bytes[at];
    at += 1;
    if (present === 0) continue;
    if (present !== 1) return null;
    const length = lengthAt(bytes, at);
    if (length === null || at + length.size + length.value > bytes.length) return null;
    const end = at + length.size + length.value;
    slots.push({ slot, key: joined(SLOT_HEADER[slot], bytes.slice(at, end)) });
    at = end;
  }
  if (bytes[at] === 0) return at + 1 === bytes.length ? slots : null;
  return bytes[at] === 1 ? slots : null;
}

/**
 * One operation's filled slots, or why they cannot be read. The slot the
 * ledger's own reading shows must be among them byte for byte, so a reading of
 * the bytes that has gone wrong is refused rather than believed.
 */
function slotsOf(op: unknown, shown: Uint8Array, name: string): SlotKey[] | string {
  const serialize = (op as { serialize?: unknown }).serialize;
  if (typeof serialize !== 'function') {
    return `entry point "${name}" carries no serialized form, so its other key slot cannot be read.`;
  }
  let bytes: unknown;
  try {
    bytes = serialize.call(op);
  } catch (e) {
    return `serializing entry point "${name}" threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  const slots = bytes instanceof Uint8Array ? slotsOfOperationBytes(bytes) : null;
  const latest = slots?.find((s) => s.slot === 'v3') ?? slots?.find((s) => s.slot === 'v2');
  if (slots === null || latest === undefined || !sameBytes(latest.key, shown)) {
    return `entry point "${name}"'s serialized bytes do not read as the key the ledger shows for it.`;
  }
  return slots;
}

/**
 * The entry points and every key each holds off a contract's state, or why
 * they cannot be read. Structural rather than typed against the ledger's class,
 * so this boundary states what it relies on.
 */
export function operationsFromContractState(state: unknown, address: string): OperationsRead {
  if (!state || typeof state !== 'object') {
    return { state: 'unreadable', address, why: 'contract state was not an object' };
  }
  const s = state as {
    operations?: () => unknown;
    operation?: (name: unknown) => unknown;
  };
  if (typeof s.operations !== 'function' || typeof s.operation !== 'function') {
    return {
      state: 'unreadable',
      address,
      why:
        'contract state does not expose `operations()` and `operation(name)`, so its verifier ' +
        'keys cannot be read. NOTHING may be concluded about them from this.'
    };
  }
  let names: unknown;
  try {
    names = s.operations();
  } catch (e) {
    return {
      state: 'unreadable',
      address,
      why: `listing this contract's entry points threw: ${e instanceof Error ? e.message : String(e)}`
    };
  }
  if (!Array.isArray(names)) {
    return { state: 'unreadable', address, why: '`operations()` did not return a list' };
  }
  const operations: OnChainOperation[] = [];
  for (const raw of names) {
    const name = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw);
    let op: unknown;
    try {
      op = s.operation(raw);
    } catch (e) {
      return {
        state: 'unreadable',
        address,
        entryPoint: name,
        why: `reading entry point "${name}" threw: ${e instanceof Error ? e.message : String(e)}`
      };
    }
    const vk = (op as { verifierKey?: unknown } | undefined)?.verifierKey;
    if (!(vk instanceof Uint8Array)) {
      return {
        state: 'unreadable',
        address,
        entryPoint: name,
        why:
          `entry point "${name}" carries no readable \`verifierKey\`. A partial answer here is ` +
          'worse than none: it would let a swapped key hide behind an unreadable one.'
      };
    }
    const slots = slotsOf(op, vk, name);
    if (typeof slots === 'string') return { state: 'unreadable', address, entryPoint: name, why: slots };
    operations.push({ name, verifierKey: vk, slots });
  }
  return { state: 'read', address, operations };
}

/**
 * One key file as an operation holding it alone, in the slot its header names:
 * `v2` for the older proving system, `v3` for the newer. Null for a file whose
 * header names neither, which the ledger itself would not take.
 */
export function operationOfKeyFile(name: string, key: Uint8Array): OnChainOperation | null {
  const version = operationVersionOfKeyFile(key);
  if (version === null) return null;
  const slot: KeySlot = version === 'v3' ? 'v2' : 'v3';
  return { name, verifierKey: key, slots: [{ slot, key }] };
}

export type VerifierKeyVerdict = 'agree' | 'disagree' | 'unknown';

export interface VerifierKeyComparison {
  verdict: VerifierKeyVerdict;
  address: string;
  why: string;
  /** Entry points whose every filled slot holds exactly the keys expected of it. */
  matched: string[];
  /** Entry points with any slot holding another key, or a slot filled or empty against what is expected. */
  mismatched: string[];
  /** Carried and not expected: an entry point this build does not know about. */
  onChainOnly: string[];
  /** Expected and not carried. */
  missingOnChain: string[];
  /** First eight bytes of each side, slot by slot, for a person. Display only: the comparison is over full bytes. */
  fingerprints: { name: string; onChain: string; expected: string }[];
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const asIs = (b: Uint8Array): Uint8Array => b;

/** Entry points that carry exactly the expected keys, those that do not, and a fingerprint of each that does not. */
function sortedByMatch(
  operations: readonly OnChainOperation[],
  expected: ReadonlyMap<string, readonly Uint8Array[]>,
  digest: (b: Uint8Array) => Uint8Array
): Pick<VerifierKeyComparison, 'matched' | 'mismatched' | 'onChainOnly' | 'fingerprints'> {
  const fp = (keys: readonly Uint8Array[]) =>
    keys
      .map((b) => hex(b.slice(0, 8)))
      .sort()
      .join('+') || '-';
  const out: ReturnType<typeof sortedByMatch> = { matched: [], mismatched: [], onChainOnly: [], fingerprints: [] };
  for (const op of operations) {
    const want = expected.get(op.name);
    if (!want) {
      out.onChainOnly.push(op.name);
      continue;
    }
    const got = op.slots.map((s) => digest(s.key));
    const [gotHex, wantHex] = [got.map(hex).sort(), want.map(hex).sort()];
    const same = gotHex.length === wantHex.length && gotHex.every((h, i) => h === wantHex[i]);
    (same ? out.matched : out.mismatched).push(op.name);
    if (!same) out.fingerprints.push({ name: op.name, onChain: fp(got), expected: fp(want) });
  }
  return out;
}

/**
 * **DOES EVERY ENTRY POINT HOLD EXACTLY THE KEYS EXPECTED OF IT, IN EVERY
 * SLOT?** The one matcher. `expected` names, for each circuit, the keys of
 * every slot it must fill, each as `digest` makes it from the key file's bytes
 * (by default the bytes themselves); a key file's header names its slot, so a
 * key in the wrong slot does not match. An operation agrees only when its
 * filled slots hold exactly those keys: a second key beside the expected one,
 * in either slot, is a disagreement. A missing or extra entry point is
 * reported in its own list and makes the verdict `disagree`; an unreadable
 * state, and a comparison over nothing, are `unknown`, which refuses like a
 * disagreement.
 */
export function verifierKeysMatch(
  read: OperationsRead,
  expected: ReadonlyMap<string, readonly Uint8Array[]>,
  digest: (b: Uint8Array) => Uint8Array = asIs
): VerifierKeyComparison {
  const empty = { matched: [], mismatched: [], onChainOnly: [], missingOnChain: [], fingerprints: [] };
  if (read.state !== 'read') {
    return {
      ...empty,
      verdict: 'unknown',
      address: read.address,
      why:
        `this contract's verifier keys could not be read — ${read.why}. NOTHING may be ` +
        'concluded: an unreadable state is not a clean one.'
    };
  }
  const sorted = sortedByMatch(read.operations, expected, digest);
  const { matched, mismatched, onChainOnly } = sorted;
  const seen = new Set(read.operations.map((op) => op.name));
  const missingOnChain = [...expected.keys()].filter((n) => !seen.has(n));
  const lists = { ...sorted, missingOnChain, address: read.address };

  if (mismatched.length > 0) {
    return {
      ...lists,
      verdict: 'disagree',
      why:
        `${mismatched.length} entry point(s) hold a verifier key this build did not produce, in one ` +
        `of their two key slots: ${mismatched.join(', ')}. **THIS IS WHAT A SWAPPED KEY LOOKS LIKE FROM ` +
        "OUTSIDE.** Whoever holds the maintenance authority can put a key into an entry point's empty " +
        'slot or replace one, and the contract then accepts proofs of a DIFFERENT statement under the ' +
        'same name, with the operations map unchanged. Do not submit anything against this contract.'
    };
  }
  if (onChainOnly.length > 0 || missingOnChain.length > 0) {
    return {
      ...lists,
      verdict: 'disagree',
      why:
        'every key this build knows about matches, and the ENTRY POINT SETS DIFFER: ' +
        `${onChainOnly.length} on chain that this build does not know (${onChainOnly.join(', ') || '-'}) ` +
        `and ${missingOnChain.length} in this build that the chain does not carry ` +
        `(${missingOnChain.join(', ') || '-'}). A key this build cannot name is a key nothing here ` +
        'can check, which is a disagreement rather than a silence.'
    };
  }
  if (matched.length === 0) {
    return {
      ...lists,
      verdict: 'unknown',
      why:
        'there was nothing to compare: the chain carries no entry points this build knows ' +
        'about and this build named none. NOTHING may be concluded — a pass over an empty set ' +
        'is an absence where evidence should be, not evidence of absence.'
    };
  }
  return {
    ...lists,
    verdict: 'agree',
    why:
      `all ${matched.length} deployed entry point(s) hold exactly the verifier keys this build ` +
      'produces, in BOTH key slots the ledger keeps for each, compared over full bytes against the ' +
      'key files.'
  };
}

/**
 * The matcher over full bytes: each circuit expects exactly one key, the file
 * as it sits on disk, header and all, which is what the chain hands back.
 */
export function compareVerifierKeys(
  read: OperationsRead,
  expected: ReadonlyMap<string, Uint8Array>
): VerifierKeyComparison {
  return verifierKeysMatch(read, new Map([...expected].map(([name, key]) => [name, [key]])));
}

/** Which released version a contract's keys are, or why they are none. */
export type ReleasedKeysAnswer =
  | { readonly released: true; readonly version: number; readonly why: string }
  | { readonly released: false; readonly why: string };

/**
 * **WHICH RELEASED VERSION ARE THESE KEYS?** A contract read off the chain is
 * matched, every circuit and every slot, against each version in the released
 * list, newest first. It is that version only when it holds exactly that
 * version's keys for this kind of contract and nothing else; a version marked
 * withdrawn is named and refused.
 */
export function releasedVersionOf(
  read: OperationsRead,
  contract: ReleasedContract,
  versions: readonly ReleasedVersion[] = RELEASED_VERSIONS
): ReleasedKeysAnswer {
  if (read.state !== 'read') return { released: false, why: verifierKeysMatch(read, new Map()).why };
  for (const v of versions) {
    if (verifierKeysMatch(read, expectedKeysOf(v, contract), sha256).verdict !== 'agree') continue;
    if (v.withdrawn) return { released: false, why: `these are the keys of version ${v.version}, which is withdrawn.` };
    return { released: true, version: v.version, why: `every key, in every slot, is version ${v.version}'s.` };
  }
  return {
    released: false,
    why:
      `these keys are not a released version of the ${contract}: no version holds exactly them, ` +
      'circuit by circuit and slot by slot.'
  };
}

/* ------------------------------------------- the second step of a company's creation */

/** The ledger pieces the second step is built from. `@midnightntwrk/ledger-v9` satisfies it. */
export interface CreationInsertPrimitives {
  VerifierKeyInsert: new (operation: string, vk: object) => object;
  ContractOperationVersionedVerifierKey: new (version: 'v3' | 'v4', rawVk: Uint8Array) => object;
  MaintenanceUpdate: new (
    address: string,
    updates: object[],
    counter: bigint
  ) => {
    readonly dataToSign: Uint8Array;
    addSignature(idx: bigint, signature: { tag: string; value: string }): unknown;
  };
}

/** Which of the account's circuits its deploy carries, and which the second step inserts. */
export interface CreationSteps {
  readonly first: readonly string[];
  readonly second: readonly string[];
}

/** The ledger's operation version for a compiled verifier key file, read from its header, or null for any other file. */
export function operationVersionOfKeyFile(vk: Uint8Array): 'v3' | 'v4' | null {
  const header = (tag: string) => new TextDecoder().decode(vk.slice(0, tag.length)) === tag;
  if (header('midnight:verifier-key[v6]:')) return 'v3';
  if (header('midnight:verifier-key[v7]:')) return 'v4';
  return null;
}

/**
 * **THE SECOND STEP OF A COMPANY'S CREATION: ONE MAINTENANCE UPDATE THAT ONLY
 * INSERTS.** One `VerifierKeyInsert` for each circuit of the second step, in
 * that order, and nothing else: no key is removed and the authority is not
 * replaced. Refused, before anything is built: a key set that is not exactly
 * the second step; a key whose file names no version the ledger takes, or that
 * `verifierKeyRefusals` refuses; an account that does not carry the first step;
 * and one that already carries any of the second, because the ledger refuses an
 * insert over a key already there after the fee is spent.
 *
 * Each key goes in under the version its own file's header names, so the insert
 * can never wrap a key as another version than it was compiled as.
 */
export function buildCreationInsert<P extends CreationInsertPrimitives>(
  P: P,
  args: {
    address: string;
    /** The contract's maintenance counter now: zero straight after its deploy. */
    counter: bigint;
    /** The operations the contract carries now. */
    onChain: readonly string[];
    keys: ReadonlyMap<string, Uint8Array>;
    steps: CreationSteps;
  }
): { update: InstanceType<P['MaintenanceUpdate']>; inserted: string[] } {
  const wanted = [...args.steps.second];
  const given = [...args.keys.keys()].sort();
  if (given.length !== wanted.length || [...wanted].sort().some((n, i) => n !== given[i])) {
    throw new Error(
      `the second step inserts exactly ${wanted.join(', ')}, and was handed keys for ${given.join(', ') || 'nothing'}. ` +
        'Nothing was built.'
    );
  }
  const already = wanted.filter((n) => args.onChain.includes(n));
  if (already.length > 0) {
    throw new Error(
      `the account at ${args.address} already carries ${already.join(', ')}, so its second step has already landed, or ` +
        'somebody else changed it. Read the account again before doing anything; nothing was built.'
    );
  }
  const missingFirst = args.steps.first.filter((n) => !args.onChain.includes(n));
  if (missingFirst.length > 0) {
    throw new Error(
      `the account at ${args.address} does not carry ${missingFirst.join(', ')}, which its deploy should have. It is ` +
        'not an account this product created; nothing was built.'
    );
  }
  const writes: VerifierKeyWrite[] = wanted.map((name) => {
    const vk = args.keys.get(name)!;
    const version = operationVersionOfKeyFile(vk);
    if (version === null) {
      throw new Error(
        `the key handed in for ${name} is not a compiled verifier key of a version the ledger takes. Rebuild the keys; ` +
          'nothing was built.'
      );
    }
    return { operation: name, version, verifierKey: vk };
  });
  const refused = verifierKeyRefusals(writes);
  if (refused.length > 0) throw new Error(`the second step will not be built: ${refused.map((r) => r.why).join(' ')}`);
  const updates = writes.map(
    (w) => new P.VerifierKeyInsert(w.operation, new P.ContractOperationVersionedVerifierKey(w.version, w.verifierKey))
  );
  return {
    update: new P.MaintenanceUpdate(args.address, updates, args.counter) as InstanceType<P['MaintenanceUpdate']>,
    inserted: wanted
  };
}

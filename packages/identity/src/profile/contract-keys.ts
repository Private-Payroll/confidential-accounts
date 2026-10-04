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
 * Whether the bytes are this build's is `compareVerifierKeys`'s question.
 */
export function verifierKeyRefusals(
  writes: readonly VerifierKeyWrite[],
): VerifierKeyRefusal[] {
  const out: VerifierKeyRefusal[] = [];
  for (const [i, w] of writes.entries()) {
    if (typeof w?.operation !== 'string' || w.operation.trim() === '') {
      out.push({
        code: 'unnamed-verifier-key-operation',
        why: `verifier-key write [${i}] names no entry point. A key written at an entry point ` +
          'nobody named is a key nothing can read back or compare.',
      });
    }
    if (!(w?.verifierKey instanceof Uint8Array) || w.verifierKey.length === 0) {
      out.push({
        code: 'empty-verifier-key',
        why: `verifier-key write [${i}] ("${String(w?.operation)}") carries no key bytes. This ` +
          'must be the `.verifier` artefact EXACTLY as it sits on disk, header and all — ' +
          'measured: that is what the chain hands back, not the header-stripped form the ' +
          'runtime constructor is handed.',
      });
    }
    if (w?.version !== 'v3' && w?.version !== 'v4') {
      out.push({
        code: 'unknown-verifier-key-version',
        why: `verifier-key write [${i}] ("${String(w?.operation)}") names version ` +
          `"${String(w?.version)}", and the runtime has exactly two: "v3" and "v4". They are ` +
          'not labels — each one requires its own header tag on the bytes and the constructor ' +
          'throws on a mismatch.',
      });
    }
  }
  return out;
}

/** One entry point and its verifier key, as a contract carries it. */
export interface OnChainOperation {
  name: string;
  verifierKey: Uint8Array;
}

export type OperationsRead =
  | { state: 'read'; address: string; operations: OnChainOperation[] }
  | { state: 'unreadable'; address: string; why: string };

/**
 * The entry points and their verifier keys off a contract's state, or why they
 * cannot be read. Structural rather than typed against the ledger's class, so
 * this boundary states what it relies on.
 */
export function operationsFromContractState(
  state: unknown, address: string,
): OperationsRead {
  if (!state || typeof state !== 'object') {
    return { state: 'unreadable', address, why: 'contract state was not an object' };
  }
  const s = state as {
    operations?: () => unknown;
    operation?: (name: unknown) => unknown;
  };
  if (typeof s.operations !== 'function' || typeof s.operation !== 'function') {
    return {
      state: 'unreadable', address,
      why: 'contract state does not expose `operations()` and `operation(name)`, so its verifier ' +
        'keys cannot be read. NOTHING may be concluded about them from this.',
    };
  }
  let names: unknown;
  try { names = s.operations(); } catch (e) {
    return {
      state: 'unreadable', address,
      why: `listing this contract's entry points threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!Array.isArray(names)) {
    return { state: 'unreadable', address, why: '`operations()` did not return a list' };
  }
  const operations: OnChainOperation[] = [];
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw : String(raw);
    let op: unknown;
    try { op = s.operation(raw); } catch (e) {
      return {
        state: 'unreadable', address,
        why: `reading entry point "${name}" threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const vk = (op as { verifierKey?: unknown } | undefined)?.verifierKey;
    if (!(vk instanceof Uint8Array)) {
      return {
        state: 'unreadable', address,
        why: `entry point "${name}" carries no readable \`verifierKey\`. A partial answer here is ` +
          'worse than none: it would let a swapped key hide behind an unreadable one.',
      };
    }
    operations.push({ name, verifierKey: vk });
  }
  return { state: 'read', address, operations };
}

export type VerifierKeyVerdict = 'agree' | 'disagree' | 'unknown';

export interface VerifierKeyComparison {
  verdict: VerifierKeyVerdict;
  address: string;
  why: string;
  /** Entry points whose key is byte-identical to the expected one. */
  matched: string[];
  /** Entry points whose key differs. */
  mismatched: string[];
  /** Carried and not expected: an entry point this build does not know about. */
  onChainOnly: string[];
  /** Expected and not carried. */
  missingOnChain: string[];
  /** First eight bytes of each side, for a person. Display only: the comparison is over full bytes. */
  fingerprints: { name: string; onChain: string; expected: string }[];
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * **DOES EVERY ENTRY POINT CARRY EXACTLY THE KEY EXPECTED OF IT?** Compared over
 * full bytes. A missing or extra entry point is reported in its own list and
 * makes the verdict `disagree`; an unreadable state, and a comparison over
 * nothing, are `unknown`, which refuses like a disagreement.
 *
 * Only the newest key of each operation is visible to this read: a key held at
 * an earlier version beside it is not, and this says nothing about one.
 */
export function compareVerifierKeys(
  read: OperationsRead,
  expected: ReadonlyMap<string, Uint8Array>,
): VerifierKeyComparison {
  const empty = { matched: [], mismatched: [], onChainOnly: [], missingOnChain: [], fingerprints: [] };
  if (read.state !== 'read') {
    return {
      ...empty, verdict: 'unknown', address: read.address,
      why: `this contract's verifier keys could not be read — ${read.why}. NOTHING may be ` +
        'concluded: an unreadable state is not a clean one.',
    };
  }
  const fp = (b: Uint8Array) => hex(b.slice(0, 8));
  const matched: string[] = [], mismatched: string[] = [], onChainOnly: string[] = [];
  const fingerprints: VerifierKeyComparison['fingerprints'] = [];
  const seen = new Set<string>();

  for (const op of read.operations) {
    seen.add(op.name);
    const want = expected.get(op.name);
    if (!want) { onChainOnly.push(op.name); continue; }
    const same = op.verifierKey.length === want.length &&
      op.verifierKey.every((b, i) => b === want[i]);
    (same ? matched : mismatched).push(op.name);
    if (!same) fingerprints.push({ name: op.name, onChain: fp(op.verifierKey), expected: fp(want) });
  }
  const missingOnChain = [...expected.keys()].filter((n) => !seen.has(n));

  if (mismatched.length > 0) {
    return {
      verdict: 'disagree', address: read.address, matched, mismatched, onChainOnly,
      missingOnChain, fingerprints,
      why: `${mismatched.length} entry point(s) carry a verifier key this build did not produce: ` +
        `${mismatched.join(', ')}. **THIS IS WHAT A SWAPPED KEY LOOKS LIKE FROM OUTSIDE.** Whoever ` +
        'holds the maintenance authority can replace an entry point\'s verifier key, and the ' +
        'contract then accepts proofs of a DIFFERENT statement under the same name, with the ' +
        'operations map unchanged. Do not submit anything against this contract.',
    };
  }
  if (onChainOnly.length > 0 || missingOnChain.length > 0) {
    return {
      verdict: 'disagree', address: read.address, matched, mismatched, onChainOnly,
      missingOnChain, fingerprints,
      why: 'every key this build knows about matches, and the ENTRY POINT SETS DIFFER: ' +
        `${onChainOnly.length} on chain that this build does not know (${onChainOnly.join(', ') || '-'}) ` +
        `and ${missingOnChain.length} in this build that the chain does not carry ` +
        `(${missingOnChain.join(', ') || '-'}). A key this build cannot name is a key nothing here ` +
        'can check, which is a disagreement rather than a silence.',
    };
  }
  if (matched.length === 0) {
    return {
      verdict: 'unknown', address: read.address, matched, mismatched, onChainOnly,
      missingOnChain, fingerprints,
      why: 'there was nothing to compare: the chain carries no entry points this build knows ' +
        'about and this build named none. NOTHING may be concluded — a pass over an empty set ' +
        'is an absence where evidence should be, not evidence of absence.',
    };
  }
  return {
    verdict: 'agree', address: read.address, matched, mismatched, onChainOnly,
    missingOnChain, fingerprints,
    why: `all ${matched.length} deployed entry point(s) carry exactly the verifier key this ` +
      'build produces, compared over FULL BYTES against the artefact on disk — AT THE LATEST ' +
      'VERSION OF EACH, which is the only version the ledger exposes. ' +
      'A key held at an earlier version is not visible from here ' +
      'and this says nothing about one.',
  };
}

/* ------------------------------------------- the second step of a company's creation */

/** The ledger pieces the second step is built from. `@midnightntwrk/ledger-v9` satisfies it. */
export interface CreationInsertPrimitives {
  VerifierKeyInsert: new (operation: string, vk: object) => object;
  ContractOperationVersionedVerifierKey: new (version: 'v3' | 'v4', rawVk: Uint8Array) => object;
  MaintenanceUpdate: new (address: string, updates: object[], counter: bigint) => {
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
  },
): { update: InstanceType<P['MaintenanceUpdate']>; inserted: string[] } {
  const wanted = [...args.steps.second];
  const given = [...args.keys.keys()].sort();
  if (given.length !== wanted.length || [...wanted].sort().some((n, i) => n !== given[i])) {
    throw new Error(
      `the second step inserts exactly ${wanted.join(', ')}, and was handed keys for ${given.join(', ') || 'nothing'}. `
        + 'Nothing was built.',
    );
  }
  const already = wanted.filter((n) => args.onChain.includes(n));
  if (already.length > 0) {
    throw new Error(
      `the account at ${args.address} already carries ${already.join(', ')}, so its second step has already landed, or `
        + 'somebody else changed it. Read the account again before doing anything; nothing was built.',
    );
  }
  const missingFirst = args.steps.first.filter((n) => !args.onChain.includes(n));
  if (missingFirst.length > 0) {
    throw new Error(
      `the account at ${args.address} does not carry ${missingFirst.join(', ')}, which its deploy should have. It is `
        + 'not an account this product created; nothing was built.',
    );
  }
  const writes: VerifierKeyWrite[] = wanted.map((name) => {
    const vk = args.keys.get(name)!;
    const version = operationVersionOfKeyFile(vk);
    if (version === null) {
      throw new Error(
        `the key handed in for ${name} is not a compiled verifier key of a version the ledger takes. Rebuild the keys; `
          + 'nothing was built.',
      );
    }
    return { operation: name, version, verifierKey: vk };
  });
  const refused = verifierKeyRefusals(writes);
  if (refused.length > 0) throw new Error(`the second step will not be built: ${refused.map((r) => r.why).join(' ')}`);
  const updates = writes.map((w) => new P.VerifierKeyInsert(w.operation, new P.ContractOperationVersionedVerifierKey(w.version, w.verifierKey)));
  return {
    update: new P.MaintenanceUpdate(args.address, updates, args.counter) as InstanceType<P['MaintenanceUpdate']>,
    inserted: wanted,
  };
}

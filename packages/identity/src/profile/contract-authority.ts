/**
 * **WHO HOLDS A CONTRACT, READ OFF ITS STATE AS THE CHAIN HOLDS IT**: the
 * committee that may change the contract's rules, how many of them must agree,
 * and how many times that committee has changed. It reads the state
 * structurally and imports nothing from the ledger, so a module that must load
 * without the ledger's WebAssembly can still call it. It refuses a state that
 * carries no committee, a key that is not a tagged hex string, a threshold
 * that is not a whole number and a counter that is not a non-negative bigint.
 */

/** One member of a contract's committee: the kind of key and its hex digits, lower-case. */
export interface AuthorityMember {
  readonly tag: string;
  readonly value: string;
}

/** Who holds a contract: its committee, the number of them who must agree, and how many times it has changed hands. */
export interface ContractAuthority {
  readonly committee: readonly AuthorityMember[];
  readonly threshold: number;
  readonly counter: bigint;
}

const HEX = /^[0-9a-fA-F]+$/u;

/**
 * **THE AUTHORITY A CONTRACT'S STATE CARRIES, OR THE SENTENCE NAMING WHAT IS
 * MISSING.** Returns the committee (every key's digits folded to lower-case
 * here, once, so no caller compares by case), the threshold and the counter,
 * frozen. Refuses a state that is not an object, one with no authority, a
 * committee that is not a list of keys with a tag and hex digits (a prefix or
 * surrounding space is refused, as the chain never holds one), a threshold
 * that is not a whole number of at least zero and a counter that is not a
 * bigint of at least zero. A threshold of zero is read, not refused: the chain
 * accepts it and the caller decides what it means. It trusts nothing about
 * the state beyond what it checks here.
 */
export function authorityIn(state: unknown): ContractAuthority | { readonly why: string } {
  if (state === null || typeof state !== 'object') return { why: 'the contract\'s state is not an object.' };
  const authority = (state as { maintenanceAuthority?: unknown }).maintenanceAuthority;
  if (authority === null || typeof authority !== 'object') return { why: 'the contract\'s state carries no maintenance authority.' };
  const raw = authority as { committee?: unknown; threshold?: unknown; counter?: unknown };
  if (!Array.isArray(raw.committee)) return { why: 'the contract\'s committee is not a list.' };
  const committee: AuthorityMember[] = [];
  for (const key of raw.committee as unknown[]) {
    const k = key as { tag?: unknown; value?: unknown } | null;
    if (k === null || typeof k !== 'object' || typeof k.tag !== 'string' || k.tag === '') {
      return { why: 'a committee member has no kind of key.' };
    }
    if (typeof k.value !== 'string' || !HEX.test(k.value)) return { why: 'a committee member\'s key is not hex digits.' };
    committee.push(Object.freeze({ tag: k.tag, value: k.value.toLowerCase() }));
  }
  if (typeof raw.threshold !== 'number' || !Number.isSafeInteger(raw.threshold) || raw.threshold < 0) {
    return { why: 'the contract\'s threshold is not a whole number of at least zero.' };
  }
  if (typeof raw.counter !== 'bigint' || raw.counter < 0n) return { why: 'the contract\'s counter is not a bigint of at least zero.' };
  return Object.freeze({ committee: Object.freeze(committee), threshold: raw.threshold, counter: raw.counter });
}

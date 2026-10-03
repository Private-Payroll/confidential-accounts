/**
 * **WHAT A VAULT'S STATE HOLDS, AND WHETHER ITS CIRCUITS ARE THIS BUILD'S** -
 * pure, so the service reading a deploy before it pays for one, and reading the
 * chain's state before money is carried in, makes the one check, in one place.
 */
import { VAULT_CIRCUITS } from './vault-contract.js';

const nameOf = (entryPoint: unknown): string =>
  entryPoint instanceof Uint8Array ? new TextDecoder().decode(entryPoint) : String(entryPoint);

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * **WHAT A NEW VAULT'S LEDGER HOLDS.** The chain does not run a contract's
 * constructor: whoever builds the deploy writes the starting state, so every
 * field is read, not only the account it is pinned to.
 */
export interface VaultStartingLedger {
  readonly account: string;
  readonly notes: bigint;
  readonly unshieldedTokens: bigint;
  readonly payments: bigint;
  /** The secret's commitment, as hex: thirty-two zero bytes until the first approved secret run. */
  readonly nonceCommitment: string;
  readonly splitJournal: bigint;
  readonly secretCopies: bigint;
  /** Entries across the seven reserved maps, which no circuit writes. */
  readonly reserved: bigint;
  /**
   * Whether the vault takes money: its account has approved a secret and every
   * signer's sealed copy of that secret is on the chain. The vault refuses money
   * until then, so a door that offered it would only fail later, with money booked.
   */
  readonly started: boolean;
}

/** The vault's compiled ledger, reduced to what a new vault must hold. */
export const startingLedgerFrom = (l: {
  readonly account: { readonly bytes: Uint8Array };
  readonly notes: { size(): bigint };
  readonly unshieldedTokens: { size(): bigint };
  readonly payments: bigint;
  readonly nonceCommitment: Uint8Array;
  readonly splitJournal: { size(): bigint };
  readonly secretCopies: { size(): bigint; member(key: Uint8Array): boolean; lookup(key: Uint8Array): Uint8Array };
  readonly reserved0: { size(): bigint };
  readonly reserved1: { size(): bigint };
  readonly reserved2: { size(): bigint };
  readonly reserved3: { size(): bigint };
  readonly reserved4: { size(): bigint };
  readonly reserved5: { size(): bigint };
  readonly reserved6: { size(): bigint };
}, copiesWrittenKey: Uint8Array): VaultStartingLedger => ({
  account: Array.from(l.account.bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
  notes: l.notes.size(),
  unshieldedTokens: l.unshieldedTokens.size(),
  payments: l.payments,
  nonceCommitment: Array.from(l.nonceCommitment, (b) => b.toString(16).padStart(2, '0')).join(''),
  splitJournal: l.splitJournal.size(),
  secretCopies: l.secretCopies.size(),
  reserved: [l.reserved0, l.reserved1, l.reserved2, l.reserved3, l.reserved4, l.reserved5, l.reserved6]
    .reduce((n, m) => n + m.size(), 0n),
  started: l.nonceCommitment.some((b) => b !== 0) && l.secretCopies.member(copiesWrittenKey)
    && sameBytes(l.secretCopies.lookup(copiesWrittenKey), l.nonceCommitment),
});

/**
 * **THE VAULT'S CIRCUITS ARE THIS BUILD'S, BYTE FOR BYTE**, or the sentence
 * that says they are not. Read on a deploy before it is paid for, and on the
 * chain's state before any money is carried in: a key that held the vault's
 * rules, even briefly, could have changed them.
 */
export function circuitsRefusal(
  state: unknown, verifierKeys: ReadonlyMap<string, Uint8Array>, what: string,
  circuits: readonly string[] = VAULT_CIRCUITS, whose = 'the vault\'s',
): string | null {
  const s = state as {
    operations?: () => unknown[];
    operation?: (name: string) => { verifierKey?: Uint8Array } | undefined;
  } | null;
  let names: string[];
  try {
    names = (s?.operations?.() ?? []).map(nameOf).sort();
  } catch {
    return `${what}: its circuits cannot be read. Nothing was sent.`;
  }
  const wanted = [...circuits].sort();
  if (names.length !== wanted.length || names.some((n, i) => n !== wanted[i])) {
    return `${what}: it has circuits other than ${whose} own. Nothing was sent.`;
  }
  for (const name of wanted) {
    let onChain: unknown;
    try { onChain = s?.operation?.(name)?.verifierKey; } catch { onChain = undefined; }
    const compiled = verifierKeys.get(name);
    if (!(onChain instanceof Uint8Array) || compiled === undefined || !sameBytes(onChain, compiled)) {
      return `${what}: its '${name}' circuit is not the one this service's build compiled, `
        + 'so it would accept proofs this product never made. Nothing was sent.';
    }
  }
  return null;
}

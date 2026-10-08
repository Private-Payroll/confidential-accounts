/**
 * **WHAT A VAULT'S STATE HOLDS, WHETHER ITS CIRCUITS ARE THIS BUILD'S, AND
 * WHETHER IT WAS BORN HELD** - pure, so the service reading a deploy before it
 * pays for one, the service reading the chain's state before money is carried
 * in, and a signer's device reading a vault's deploy before it is adopted, make
 * the one check, in one place.
 */
import { VAULT_CIRCUITS } from './vault-contract.js';
import { sameCommittee, whyOneKeyCouldActAlone, type Committee } from './vault-committee.js';

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

/**
 * **A CONTRACT'S STATE AT DEPLOY STARTS WITH NO MONEY**, or the sentence that
 * says it would not. The one reading of a deploy's starting balance, for the
 * vault's deploy and the account's alike: any token at all, the fee token
 * included, refuses it.
 */
export function startsHoldingMoney(initialState: unknown, what: string): string | null {
  const balance = (initialState as { balance?: unknown } | null)?.balance;
  return balance instanceof Map && balance.size > 0 ? `${what}: it would start holding money. Nothing was sent.` : null;
}

/** What a vault born held must be, as it was deployed. */
export interface VaultBornHeldExpectations {
  /** The company's account the vault is pinned to, 64 hex characters. */
  readonly account: string;
  /** The keys that hold the company's rules, and how many of them must sign: the vault is held by exactly these. */
  readonly holders: Committee;
  /** Every vault circuit's verifying key as this build compiled it, by circuit name. */
  readonly verifierKeys: ReadonlyMap<string, Uint8Array>;
  /** What a vault's state holds, read through the vault's own compiled ledger. Throws for a state that is not a vault's. */
  readonly startingLedgerOf: (initialState: unknown) => VaultStartingLedger;
}

const bare = (h: unknown): string => String(h).trim().toLowerCase().replace(/^0x/u, '');

/**
 * **A VAULT AS IT WAS DEPLOYED IS BORN HELD, OR THE SENTENCE THAT SAYS IT IS
 * NOT.** Held by exactly the company's committee at the company's threshold,
 * never changed, a committee no one of whose keys could change it alone; no
 * money; this build's circuits; pinned to this company's account; and nothing
 * written that only the company's approved runs write - no note, payment,
 * secret, sealed copy, copies-written mark, split or reserved entry.
 *
 * The one reading of a vault's state at deploy: the service reads a deploy with
 * it before paying for one, and a signer's device reads the deploy the vault's
 * address was made from with it before the vault is adopted or set up. After
 * that, changing who holds the vault or which circuits it runs needs the
 * committee's signatures, and its state changes only through those circuits,
 * so nothing later is read for it.
 */
/**
 * **WHO HOLDS A CONTRACT, AS ITS STATE SAYS**: the committee and threshold of
 * its maintenance authority, and how many times that authority has changed;
 * null when the state carries no authority this can read.
 */
export function authorityOfState(contractState: unknown): (Committee & { readonly counter: unknown }) | null {
  const authority = (contractState as {
    maintenanceAuthority?: { committee?: unknown[]; threshold?: unknown; counter?: unknown };
  } | null)?.maintenanceAuthority;
  if (!Array.isArray(authority?.committee) || typeof authority?.threshold !== 'number') return null;
  return {
    committee: authority.committee.map((k) => ({ tag: String((k as { tag?: unknown }).tag), value: bare((k as { value?: unknown }).value) })),
    threshold: authority.threshold,
    counter: authority.counter,
  };
}

export function vaultBornHeldRefusal(initialState: unknown, expect: VaultBornHeldExpectations, what: string): string | null {
  const state = initialState as Record<string, unknown> | null;
  const authority = authorityOfState(state);
  if (authority === null || authority.counter !== 0n
    || !sameCommittee({ committee: authority.committee, threshold: authority.threshold }, expect.holders)) {
    return `this is not ${what}: a vault is held from its first transaction by the company's committee, at the `
      + 'company\'s threshold, and this one is held by other keys, at another threshold, or was changed. Nothing was sent.';
  }
  const alone = whyOneKeyCouldActAlone(expect.holders);
  if (alone !== null) return `this is not ${what}: ${alone}. Nothing was sent.`;
  const money = startsHoldingMoney(state, `this is not ${what}`);
  if (money !== null) return money;
  const circuits = circuitsRefusal(state, expect.verifierKeys, `this is not ${what}`);
  if (circuits !== null) return circuits;
  let start: VaultStartingLedger;
  try {
    start = expect.startingLedgerOf(state);
  } catch {
    return `this is not ${what}: its state is not a vault's. Nothing was sent.`;
  }
  const pinned = bare(start.account);
  if (!/^[0-9a-f]{64}$/u.test(pinned)) return `this is not ${what}: its state is not a vault's. Nothing was sent.`;
  if (pinned !== bare(expect.account)) {
    return `this is not ${what}: it is pinned to a different company's account, so this company could `
      + 'never pay out of it. Nothing was sent.';
  }
  if (start.notes !== 0n || start.unshieldedTokens !== 0n || start.payments !== 0n) {
    return `this is not ${what}: it starts with records a new vault does not have - notes, public tokens `
      + 'or payments already written - so its pool could never match it. Nothing was sent.';
  }
  /*
   * A vault takes money only once it has a secret, and it gets one only from a
   * run the account approved. A deploy that wrote a commitment, a sealed copy
   * (the copies-written mark among them), a split or a reserved entry into its
   * own starting state would skip that.
   */
  if (!/^0{64}$/u.test(start.nonceCommitment) || start.splitJournal !== 0n || start.secretCopies !== 0n
    || start.reserved !== 0n) {
    return `this is not ${what}: it starts with a secret, a sealed copy, a split or a reserved entry already `
      + 'written, which only the company\'s approved runs may write, so it could take money nobody approved. '
      + 'Nothing was sent.';
  }
  return null;
}

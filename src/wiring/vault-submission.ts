/**
 * **WHAT THE COMPANY'S FEE PAYER WILL PAY FOR ON A VAULT, AND WHEN A VAULT MAY
 * TAKE MONEY.**
 *
 * A signer's device builds and proves four kinds of transaction for a vault,
 * and this service pays the network fee on each. Paying is a choice, so each is
 * read here first and refused unless it is exactly what its route says:
 *
 *   1. **a vault deployed for this company**: one deploy and nothing else, of
 *      the vault this build compiles - every circuit, every verifying key byte
 *      for byte - pinned to this company's own account, holding nothing, with a
 *      single temporary maintenance key;
 *   2. **that vault handed to the company's committee**: one maintenance update
 *      and nothing else, replacing the whole authority with exactly the
 *      company's committee, against the counter the chain holds now;
 *   3. **a deposit into a vault the committee holds**: calls to that vault's
 *      `deposit` and nothing else, with coins the depositor's own wallet added;
 *   4. **a private payment out of that vault**: the vault's `payout` and the
 *      company account's `recordPayment` it asks, and nothing else, spending one
 *      coin the vault owns into one person's coin and at most one coin back to
 *      the vault, balanced in its own money so the fee payer adds only DUST.
 *
 * And the one rule that decides whether any money may go in at all:
 * **the vault's maintenance authority, read from the chain, must be the
 * company's committee.** Never a record this service keeps, because a check
 * against our own record is a check against our own claim.
 *
 * WHAT NOTHING HERE CAN CHANGE: the authority is a ledger field no circuit can
 * read, and a deposit is a public entry point anybody can call. So a stranger
 * can put money into a vault whose handover has not landed, and no contract can
 * refuse it. What this service refuses is paying for, or carrying, any deposit
 * into such a vault.
 */
import type { AuthorityRead, OnChainAuthority } from '../midnight/ledger.js';
import { compareAuthority } from '../midnight/ledger.js';
import type { Committee, CommitteeKey } from '../midnight/vault-committee.js';
import { sameCommittee } from '../midnight/vault-committee.js';
import { VAULT_CIRCUITS } from '../midnight/vault-contract.js';

const bare = (a: unknown): string => String(a).trim().toLowerCase().replace(/^0x/u, '');
const nameOf = (entryPoint: unknown): string =>
  entryPoint instanceof Uint8Array ? new TextDecoder().decode(entryPoint) : String(entryPoint);

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const emptyOffer = (offer: unknown, parts: readonly string[]): boolean => {
  if (offer === undefined || offer === null) return true;
  if (typeof offer !== 'object') return false;
  return parts.every((k) => {
    const v = (offer as Record<string, unknown>)[k];
    return Array.isArray(v) && v.length === 0;
  });
};

interface TxShape {
  intents?: unknown;
  guaranteedOffer?: unknown;
  fallibleOffer?: unknown;
}
interface IntentShape {
  actions?: unknown;
  guaranteedUnshieldedOffer?: unknown;
  fallibleUnshieldedOffer?: unknown;
  dustActions?: unknown;
}

/** The one intent a fee-only transaction carries, or a refusal. */
const theOnlyIntent = (tx: unknown, what: string): { intent: IntentShape } | { refusal: string } => {
  const t = tx as TxShape | null;
  if (!(t?.intents instanceof Map) || t.intents.size !== 1) {
    return { refusal: `this is not ${what}: it must carry exactly one set of actions. Nothing was sent.` };
  }
  if (!emptyOffer(t.guaranteedOffer, ['inputs', 'outputs', 'transients'])
    || (t.fallibleOffer !== undefined && t.fallibleOffer !== null
      && (!(t.fallibleOffer instanceof Map) || [...t.fallibleOffer.values()].some(
        (o) => !emptyOffer(o, ['inputs', 'outputs', 'transients']))))) {
    return { refusal: `this is not ${what}: it moves coins, and the company pays only for one that moves none. Nothing was sent.` };
  }
  const intent = [...t.intents.values()][0] as IntentShape | null;
  if (!intent || !emptyOffer(intent.guaranteedUnshieldedOffer, ['inputs', 'outputs'])
    || !emptyOffer(intent.fallibleUnshieldedOffer, ['inputs', 'outputs'])
    || !emptyOffer(intent.dustActions, ['spends', 'registrations'])) {
    return { refusal: `this is not ${what}: it moves coins, and the company pays only for one that moves none. Nothing was sent.` };
  }
  if (!Array.isArray(intent.actions) || intent.actions.length !== 1) {
    return { refusal: `this is not ${what}: it must do exactly one thing. Nothing was sent.` };
  }
  return { intent };
};

/* ------------------------------------------------------------ 1. the deploy */

export interface VaultDeployExpectations {
  /** This company's account contract address. */
  readonly account: string;
  /** Every circuit's verifying key as this build compiled it, by circuit name. */
  readonly verifierKeys: ReadonlyMap<string, Uint8Array>;
  /** What a vault's state holds, read through the vault's own compiled ledger. Throws for a state that is not a vault's. */
  readonly startingLedgerOf: (initialState: unknown) => VaultStartingLedger;
}

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
  readonly spendingCaps: bigint;
}

/** The vault's compiled ledger, reduced to what a new vault must hold. */
export const startingLedgerFrom = (l: {
  readonly account: { readonly bytes: Uint8Array };
  readonly notes: { size(): bigint };
  readonly unshieldedTokens: { size(): bigint };
  readonly payments: bigint;
  readonly spendingCaps: { size(): bigint };
}): VaultStartingLedger => ({
  account: Array.from(l.account.bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
  notes: l.notes.size(),
  unshieldedTokens: l.unshieldedTokens.size(),
  payments: l.payments,
  spendingCaps: l.spendingCaps.size(),
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

export type DeployVerdict = { readonly vault: string } | { readonly refusal: string };

export function readVaultDeploy(tx: unknown, expect: VaultDeployExpectations): DeployVerdict {
  const what = 'a new vault for this company';
  const only = theOnlyIntent(tx, what);
  if ('refusal' in only) return only;
  const deploy = (only.intent.actions as unknown[])[0] as {
    address?: unknown; initialState?: unknown; entryPoint?: unknown; updates?: unknown;
  };
  if (deploy.initialState === undefined || deploy.address === undefined || deploy.entryPoint !== undefined) {
    return { refusal: `this is not ${what}: it does something other than deploy a contract. Nothing was sent.` };
  }
  const state = deploy.initialState as {
    operations?: () => unknown[];
    operation?: (name: string) => { verifierKey?: Uint8Array } | undefined;
    maintenanceAuthority?: { committee?: unknown[]; threshold?: unknown; counter?: unknown };
    balance?: Map<unknown, unknown>;
  };
  const authority = state.maintenanceAuthority;
  if (!authority || !Array.isArray(authority.committee) || authority.committee.length !== 1
    || authority.threshold !== 1 || authority.counter !== 0n) {
    return {
      refusal: `this is not ${what}: a vault is deployed with one temporary key, which the device hands to `
        + 'the company\'s committee straight after, and this one carries another authority. Nothing was sent.',
    };
  }
  if (state.balance instanceof Map && state.balance.size > 0) {
    return { refusal: `this is not ${what}: it would start holding money. Nothing was sent.` };
  }
  const circuits = circuitsRefusal(state, expect.verifierKeys, `this is not ${what}`);
  if (circuits !== null) return { refusal: circuits };
  let start: VaultStartingLedger;
  try {
    start = expect.startingLedgerOf(state);
  } catch {
    return { refusal: `this is not ${what}: its state is not a vault's. Nothing was sent.` };
  }
  const pinned = bare(start.account);
  if (!/^[0-9a-f]{64}$/u.test(pinned)) {
    return { refusal: `this is not ${what}: its state is not a vault's. Nothing was sent.` };
  }
  if (pinned !== bare(expect.account)) {
    return {
      refusal: `this is not ${what}: it is pinned to a different company's account, so this company could `
        + 'never pay out of it. Nothing was sent.',
    };
  }
  if (start.notes !== 0n || start.unshieldedTokens !== 0n || start.payments !== 0n || start.spendingCaps !== 0n) {
    return {
      refusal: `this is not ${what}: it starts with records a new vault does not have - notes, public tokens, `
        + 'payments or spending limits already written - so its pool could never match it. Nothing was sent.',
    };
  }
  return { vault: bare(deploy.address) };
}

/* ---------------------------------------------------------- 2. the handover */

/**
 * **A CONTRACT HANDED FROM ITS TEMPORARY KEY TO THE COMPANY'S COMMITTEE.** The
 * same reading serves a vault, whose temporary key a signer's device made, and
 * the company account, whose temporary key this service keeps: either way it is
 * one change, the first the contract has ever had, installing exactly the
 * committee.
 */
export function refusalForHandover(
  tx: unknown,
  expect: {
    readonly vault: string; readonly to: Committee; readonly onChain: OnChainAuthority;
    readonly contract?: 'vault' | 'account';
  },
): string | null {
  const noun = expect.contract === 'account' ? 'the company\'s account' : 'this vault';
  const its = expect.contract === 'account' ? 'the account\'s' : 'the vault\'s';
  const what = `${noun} being handed to the company's committee`;
  const only = theOnlyIntent(tx, what);
  if ('refusal' in only) return only.refusal;
  const update = (only.intent.actions as unknown[])[0] as {
    address?: unknown; updates?: unknown; counter?: unknown; signatures?: unknown; entryPoint?: unknown;
  };
  if (update.entryPoint !== undefined || !Array.isArray(update.updates) || update.address === undefined) {
    return `this is not ${what}: it does something other than change ${its} rules. Nothing was sent.`;
  }
  if (bare(update.address) !== bare(expect.vault)) {
    return `this is not ${what}: it changes a different contract. Nothing was sent.`;
  }
  if (expect.onChain.shape !== 'one-key') {
    return `${noun} is no longer held by its temporary key, so there is nothing to hand over. Nothing was sent.`;
  }
  /*
   * **THE TEMPORARY KEY SIGNS ONE CHANGE, AND IT IS THIS ONE.** A vault is
   * deployed at counter 0; a counter above it means its temporary key already
   * changed its rules - perhaps which proofs it accepts - and a vault like that
   * is never handed to the committee as if it were new.
   */
  if (expect.onChain.counter !== 0n) {
    return expect.contract === 'account'
      ? 'the company\'s account has already had its rules changed by the key it was created with, so it is not '
        + 'handed to the committee and no money goes into any of its vaults. Nothing was sent.'
      : 'this vault\'s rules were already changed by the key it was created with, so it is not handed to '
        + 'the committee and no money goes into it. Nothing was sent; create a new vault.';
  }
  if (update.counter !== expect.onChain.counter) {
    return `this change was built against counter ${String(update.counter)} and ${noun} is at `
      + `${expect.onChain.counter}, so the chain would refuse it after charging the fee. Nothing was sent; `
      + 'build it again from what the chain holds now.';
  }
  if (update.updates.length !== 1) {
    return `this is not ${what}: it makes more than one change. Nothing was sent.`;
  }
  const authority = (update.updates[0] as { authority?: { committee?: unknown; threshold?: unknown; counter?: unknown } })
    .authority;
  if (!authority || !Array.isArray(authority.committee) || typeof authority.threshold !== 'number') {
    return `this is not ${what}: it changes something other than who holds ${its} rules. Nothing was sent.`;
  }
  const installs: Committee = {
    committee: (authority.committee as CommitteeKey[]).map((k) => ({ tag: k.tag, value: k.value })),
    threshold: authority.threshold,
  };
  if (!sameCommittee(installs, expect.to)) {
    return `this is not ${what}: the keys or the threshold it installs are not this company's committee. `
      + 'Nothing was sent.';
  }
  if (authority.counter !== expect.onChain.counter + 1n) {
    return `this is not ${what}: the authority it installs carries the wrong counter. Nothing was sent.`;
  }
  if (!Array.isArray(update.signatures) || update.signatures.length === 0) {
    return `this is not ${what}: nobody signed it, so the chain would refuse it. Nothing was sent.`;
  }
  return null;
}

/* ----------------------------------------------------------- 3. the deposit */

export function refusalForDeposit(tx: unknown, expect: { readonly vault: string }): string | null {
  const t = tx as TxShape | null;
  if (!(t?.intents instanceof Map) || t.intents.size === 0) {
    return 'this deposit calls nothing, so there is nothing to pay for. Nothing was sent.';
  }
  let calls = 0;
  for (const value of t.intents.values()) {
    const intent = value as IntentShape | null;
    if (!intent || !Array.isArray(intent.actions)) {
      return 'this deposit could not be read, so it was not paid for. Nothing was sent.';
    }
    if (!emptyOffer(intent.guaranteedUnshieldedOffer, ['inputs', 'outputs'])
      || !emptyOffer(intent.fallibleUnshieldedOffer, ['inputs', 'outputs'])) {
      return 'this deposit moves public money as well, and a private deposit moves none. Nothing was sent.';
    }
    if (!emptyOffer(intent.dustActions, ['spends', 'registrations'])) {
      return 'this deposit already pays a network fee from somewhere else, and the company pays its '
        + 'fees itself. Nothing was sent.';
    }
    for (const action of intent.actions) {
      const call = action as { address?: unknown; entryPoint?: unknown } | null;
      if (!call || call.entryPoint === undefined || call.address === undefined) {
        return 'this deposit does something other than call the vault. Nothing was sent.';
      }
      if (bare(call.address) !== bare(expect.vault) || nameOf(call.entryPoint) !== 'deposit') {
        return 'this deposit calls something other than this vault\'s deposit. Nothing was sent.';
      }
      calls += 1;
    }
  }
  if (calls === 0) return 'this deposit calls nothing, so there is nothing to pay for. Nothing was sent.';
  return null;
}

/* ------------------------------------------------ 4. a private payment out */

/** The two contracts a private payment out of a company's vault touches. */
export interface PayoutExpectations {
  /** The vault the money leaves. */
  readonly vault: string;
  /** The company's own account, whose approval the vault asks for. */
  readonly account: string;
}

interface ShieldedPart { readonly contractAddress?: unknown }
interface ShieldedOfferShape {
  readonly inputs?: unknown;
  readonly outputs?: unknown;
  readonly transients?: unknown;
}

const ownerOf = (part: ShieldedPart): string | null =>
  part.contractAddress === undefined || part.contractAddress === null ? null : bare(part.contractAddress);

/**
 * **`null` ONLY FOR A PAYMENT THAT MOVES THIS VAULT'S OWN MONEY TO ONE PERSON
 * AND NOTHING ELSE.**
 *
 * What the chain decides is not decided here: whether the company approved the
 * run, whether the window is open, whether this person was already paid. The
 * vault asks the account all of that inside the same transaction, and a payment
 * the account refuses is not applied. What is decided here is only whether the
 * fee payer adds DUST to it, and it adds DUST to nothing that could spend a coin
 * of anybody else's, send public money, pay a fee from elsewhere, or leave any
 * imbalance but the fee for somebody to fill.
 */
export function refusalForPayout(tx: unknown, expect: PayoutExpectations): string | null {
  const what = 'a private payment out of this company\'s vault';
  const t = tx as (TxShape & { imbalances?: (segment: number) => Map<{ tag?: unknown }, bigint> }) | null;
  if (!(t?.intents instanceof Map) || t.intents.size !== 1) {
    return `this is not ${what}: it must carry exactly one set of actions. Nothing was sent.`;
  }
  const intent = [...t.intents.values()][0] as IntentShape | null;
  if (!intent || !Array.isArray(intent.actions)) {
    return `this is not ${what}: it could not be read, so it was not paid for. Nothing was sent.`;
  }
  if (!emptyOffer(intent.guaranteedUnshieldedOffer, ['inputs', 'outputs'])
    || !emptyOffer(intent.fallibleUnshieldedOffer, ['inputs', 'outputs'])) {
    return `this is not ${what}: it moves public money as well, and a private payment moves none. Nothing was sent.`;
  }
  if (!emptyOffer(intent.dustActions, ['spends', 'registrations'])) {
    return `this is not ${what}: it already pays a network fee from somewhere else. Nothing was sent.`;
  }
  /*
   * **EXACTLY THE TWO CALLS A PAYOUT IS, AND NO THIRD.** The vault's `payout`
   * and the account's `recordPayment` it asks. The account is this company's:
   * a vault pinned elsewhere would be asking some other company's approvals.
   */
  const called: string[] = [];
  for (const action of intent.actions) {
    const call = action as { address?: unknown; entryPoint?: unknown } | null;
    if (!call || call.entryPoint === undefined || call.address === undefined) {
      return `this is not ${what}: it does something other than call the vault and the account. Nothing was sent.`;
    }
    called.push(`${bare(call.address)}/${nameOf(call.entryPoint)}`);
  }
  const wanted = [`${bare(expect.account)}/recordPayment`, `${bare(expect.vault)}/payout`];
  if (called.length !== 2 || [...called].sort().join() !== [...wanted].sort().join()) {
    return `this is not ${what}: it must call this vault's payout and this company's approval of it, and `
      + 'nothing else. Nothing was sent.';
  }
  /*
   * **THE COINS: ONE OF THE VAULT'S IN, ONE PERSON'S OUT, AND AT MOST ONE BACK
   * TO THE VAULT.** Read across the guaranteed part and every fallible part,
   * because a coin in either is a coin moved.
   */
  const offers: ShieldedOfferShape[] = [];
  if (t.guaranteedOffer !== undefined && t.guaranteedOffer !== null) offers.push(t.guaranteedOffer as ShieldedOfferShape);
  if (t.fallibleOffer !== undefined && t.fallibleOffer !== null) {
    if (!(t.fallibleOffer instanceof Map)) {
      return `this is not ${what}: its coins could not be read, so it was not paid for. Nothing was sent.`;
    }
    offers.push(...[...t.fallibleOffer.values()] as ShieldedOfferShape[]);
  }
  const inputs: ShieldedPart[] = [];
  const outputs: ShieldedPart[] = [];
  for (const offer of offers) {
    if (!Array.isArray(offer.inputs) || !Array.isArray(offer.outputs) || !Array.isArray(offer.transients)) {
      return `this is not ${what}: its coins could not be read, so it was not paid for. Nothing was sent.`;
    }
    if (offer.transients.length > 0) {
      return `this is not ${what}: it makes and spends a coin in one go, which a payout never does. Nothing was sent.`;
    }
    inputs.push(...offer.inputs as ShieldedPart[]);
    outputs.push(...offer.outputs as ShieldedPart[]);
  }
  if (inputs.length !== 1 || ownerOf(inputs[0]!) !== bare(expect.vault)) {
    return `this is not ${what}: it must spend exactly one coin, and that coin must be this vault's. Nothing was sent.`;
  }
  const toPeople = outputs.filter((o) => ownerOf(o) === null);
  const toContracts = outputs.filter((o) => ownerOf(o) !== null);
  if (toPeople.length !== 1) {
    return `this is not ${what}: it must pay exactly one person. Nothing was sent.`;
  }
  if (toContracts.length > 1 || toContracts.some((o) => ownerOf(o) !== bare(expect.vault))) {
    return `this is not ${what}: what it does not pay out may only go back to this vault. Nothing was sent.`;
  }
  /*
   * **BALANCED IN ITS OWN MONEY.** The fee payer adds DUST and nothing else, so
   * anything else left unbalanced is either somebody else's to fill or a
   * transaction the network refuses after the fee payer has booked for it.
   */
  if (typeof t.imbalances !== 'function') {
    return `this is not ${what}: what it moves could not be added up, so it was not paid for. Nothing was sent.`;
  }
  const segments = [0, ...(t.fallibleOffer instanceof Map ? [...t.fallibleOffer.keys()].map(Number) : [])];
  for (const segment of segments) {
    let owed: Map<{ tag?: unknown }, bigint>;
    try {
      owed = t.imbalances(segment);
    } catch {
      return `this is not ${what}: what it moves could not be added up, so it was not paid for. Nothing was sent.`;
    }
    for (const [token, amount] of owed) {
      if (token?.tag !== 'dust' && amount !== 0n) {
        return `this is not ${what}: it does not balance in its own money, and the company pays only the network `
          + 'fee. Nothing was sent.';
      }
    }
  }
  return null;
}

/* ------------------------------------------------- whether money may go in */

/**
 * **`null` ONLY WHEN THE CHAIN SAYS THE COMPANY'S COMMITTEE HOLDS THIS VAULT.**
 * A chain that cannot be read is a refusal, not a pass.
 */
export function fundingRefusal(read: AuthorityRead, to: Committee): string | null {
  const verdict = compareAuthority(read, { committee: to.committee.map((k) => ({ ...k })), threshold: to.threshold });
  if (verdict.verdict === 'agree') return null;
  if (verdict.verdict === 'unknown') {
    return 'the chain could not be asked who holds this vault\'s rules, so no money goes in. Nothing was '
      + 'sent; try again when the chain answers.';
  }
  return 'this vault\'s rules are not held by the company\'s committee on the chain, so no money goes in: '
    + `${verdict.why} If the vault was created here, finish handing it to the committee first. Nothing was sent.`;
}

/**
 * **FOR THE OPERATOR TOOLS, WHICH HAVE NO COMPANY COMMITTEE TO COMPARE WITH.**
 * `null` only when the chain answers and holds neither a single key nor any key
 * `held` lists - the keys this machine keeps.
 */
export function heldKeyFundingRefusal(
  read: AuthorityRead, held: readonly CommitteeKey[], label: string,
): string | null {
  if (read.state !== 'read') {
    return `the chain could not be asked who holds the rules of vault '${label}' (${read.why}), so it is `
      + 'not funded. Nothing was sent.';
  }
  const heldIds = new Set(held.map((k) => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`));
  const ours = read.authority.committee.some((k) => heldIds.has(`${k.tag.toLowerCase()}:${k.value.toLowerCase()}`));
  if (ours || read.authority.shape === 'one-key' || read.authority.shape === 'anyone') {
    return `vault '${label}' is still held by ${ours ? 'a key this machine keeps' : 'a single key'} on the chain `
      + `(${read.authority.committee.length} key(s), threshold ${read.authority.threshold}), so it is not funded: `
      + 'whoever holds that key can change which proofs the vault accepts. Hand the vault to a committee '
      + 'nobody here holds a key of, then fund it. Nothing was sent.';
  }
  /*
   * A committee any ONE of whose members can act alone is a single key several
   * times over; one listing a key twice is not the threshold it reads as; and a
   * vault nobody can maintain can never be retired or repaired.
   */
  if (read.authority.shape !== 'committee' || read.authority.threshold < 2 || read.authority.hasDuplicateMembers) {
    const why = read.authority.shape === 'no-one'
      ? 'nobody can ever change its rules, so it could never be repaired or retired'
      : read.authority.hasDuplicateMembers
        ? 'its committee lists one key more than once, so its threshold is not what it reads as'
        : 'any one member of its committee can change which proofs it accepts';
    return `vault '${label}' is not funded: ${why} (${read.authority.committee.length} key(s), threshold `
      + `${read.authority.threshold}). Nothing was sent.`;
  }
  return null;
}

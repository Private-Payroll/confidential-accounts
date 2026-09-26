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
 *      or one call to its public deposit, of exactly the token and amount the
 *      page asked for, paid from the depositor's own public money;
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

/* ------------------------------------------ 2a. a committee changed after */

/**
 * **A CONTRACT OF THIS COMPANY'S CHANGED TO THE COMPANY'S COMMITTEE AS IT
 * STANDS NOW, SIGNED BY THE COMMITTEE THAT HOLDS IT.** Read as a stranger's
 * transaction, whoever assembled it: one maintenance update and nothing else,
 * replacing the whole authority with exactly the company's committee, against
 * the counter the chain holds now, carrying at least as many signatures as the
 * committee on chain requires. A contract still held by the key it was created
 * with is not changed this way; that is its handover.
 */
export function refusalForCommitteeChange(
  tx: unknown,
  expect: {
    readonly address: string; readonly to: Committee; readonly onChain: OnChainAuthority;
    readonly contract: 'vault' | 'account';
  },
): string | null {
  const noun = expect.contract === 'account' ? 'the company\'s account' : 'this vault';
  const its = expect.contract === 'account' ? 'the account\'s' : 'the vault\'s';
  const what = `${noun}'s committee changed to the company's`;
  const only = theOnlyIntent(tx, what);
  if ('refusal' in only) return only.refusal;
  const update = (only.intent.actions as unknown[])[0] as {
    address?: unknown; updates?: unknown; counter?: unknown; signatures?: unknown; entryPoint?: unknown;
  };
  if (update.entryPoint !== undefined || !Array.isArray(update.updates) || update.address === undefined) {
    return `this is not ${what}: it does something other than change ${its} rules. Nothing was sent.`;
  }
  if (bare(update.address) !== bare(expect.address)) {
    return `this is not ${what}: it changes a different contract. Nothing was sent.`;
  }
  if (expect.onChain.shape === 'one-key' && expect.onChain.counter === 0n) {
    return `${noun} is still held by the key it was created with, so it is handed to the committee first. Nothing was sent.`;
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
  if (!Array.isArray(update.signatures) || update.signatures.length < Math.max(1, expect.onChain.threshold)) {
    return `this is not ${what}: it carries fewer signatures than the ${expect.onChain.threshold} the committee `
      + 'holding it now needs, so the chain would refuse it. Nothing was sent.';
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
  return refusalForADepositThatStatesItsMoney(t as TxShape & { imbalances?: unknown });
}

/**
 * **A FINISHED PRIVATE DEPOSIT STATES NO TOKEN AND NO AMOUNT.**
 *
 * The vault's deposit asks for a coin of one token and one amount, and until
 * the depositor's wallet balances it the transaction's private offer carries
 * that token and the amount as an open imbalance, which anybody reading the
 * chain can see. The wallet balances it by adding its own coin, and what is
 * left states neither. So a deposit whose private offers still carry any
 * imbalance, in any part, is one this service would publish with its money
 * showing, and it is not sent. Only the network fee may still be owed, and
 * that is paid in DUST.
 *
 * Read twice, because either alone could be fooled by a transaction built
 * some other way: each offer's own `deltas`, and the transaction's
 * `imbalances` for every part. A transaction whose offers cannot be read
 * this way is refused as well; one with no private offer at all states no
 * private money.
 */
function refusalForADepositThatStatesItsMoney(t: TxShape & { imbalances?: unknown }): string | null {
  const states = 'your wallet did not finish this deposit privately, so anyone reading the chain could have seen which '
    + 'token it moves and how much. Nothing was sent and no money moved. Put the money in again from your wallet.';
  const unreadable = 'this service could not confirm that the deposit hides which token it moves and how much, so it '
    + 'was not sent. Nothing was sent and no money moved. Put the money in again from your wallet.';
  const offers: unknown[] = [];
  if (t.guaranteedOffer !== undefined && t.guaranteedOffer !== null) offers.push(t.guaranteedOffer);
  if (t.fallibleOffer !== undefined && t.fallibleOffer !== null) {
    if (!(t.fallibleOffer instanceof Map)) return unreadable;
    offers.push(...t.fallibleOffer.values());
  }
  for (const offer of offers) {
    const deltas = (offer as { deltas?: unknown } | null)?.deltas;
    if (deltas === undefined) continue;
    let entries: unknown[];
    if (deltas instanceof Map) entries = [...deltas.entries()];
    else if (Array.isArray(deltas)) entries = deltas;
    else return unreadable;
    for (const entry of entries) {
      if (!Array.isArray(entry) || typeof entry[1] !== 'bigint') return unreadable;
      if (entry[1] !== 0n) return states;
    }
  }
  if (offers.length === 0) return null;
  if (typeof t.imbalances !== 'function') return unreadable;
  const segments = new Set<number>([0]);
  for (const key of t.intents instanceof Map ? t.intents.keys() : []) segments.add(Number(key));
  for (const key of t.fallibleOffer instanceof Map ? t.fallibleOffer.keys() : []) segments.add(Number(key));
  for (const segment of segments) {
    let owed: unknown;
    try {
      owed = (t.imbalances as (s: number) => unknown).call(t, segment);
    } catch {
      return unreadable;
    }
    if (!(owed instanceof Map)) return unreadable;
    for (const [token, amount] of owed as Map<{ tag?: unknown } | null, unknown>) {
      if (typeof amount !== 'bigint') return unreadable;
      if (token?.tag !== 'dust' && amount !== 0n) return states;
    }
  }
  return null;
}

/* ------------------------------------------------ 3b. a public deposit */

/** What a public deposit must put into the vault, as the page asked for it. */
export interface PublicDepositExpectations {
  /** The vault the money goes into. */
  readonly vault: string;
  /** The one public token that goes in. */
  readonly token: string;
  /** How much of it, in its smallest unit. */
  readonly amount: bigint;
  /** The address a public input's owner is paid change at: the ledger's own `addressFromKey`. */
  readonly addressOf: (owner: unknown) => string;
}

/**
 * **`null` ONLY FOR EXACTLY ONE PUBLIC DEPOSIT OF THIS TOKEN AND THIS AMOUNT INTO
 * THIS VAULT, PAID FOR BY THE DEPOSITOR'S OWN PUBLIC MONEY.**
 *
 * The vault's public deposit asks the transaction for one token and one amount,
 * and the chain adds them to the vault's public balance. So what is read here:
 *
 *   · one call, to this vault's `depositUnshielded`, and nothing else;
 *   · what that call asks for, read from its own declared effects: exactly
 *     this amount of this token, and no coin, no other token, nothing paid out
 *     and no other contract called;
 *   · no private coin anywhere in it;
 *   · every public coin it spends belongs to whoever pays for it, and every
 *     public coin it makes goes back to one of those owners as change, so the
 *     only money that leaves the depositor goes into this vault;
 *   · it balances in its own money, so the company's fee payer adds only DUST;
 *   · no fee already paid from anywhere else.
 */
export function refusalForPublicDeposit(tx: unknown, expect: PublicDepositExpectations): string | null {
  const what = 'this company\'s public deposit into this vault';
  const t = tx as (TxShape & { imbalances?: (segment: number) => Map<{ tag?: unknown }, bigint> }) | null;
  if (!(t?.intents instanceof Map) || t.intents.size !== 1) {
    return `this is not ${what}: it must carry exactly one set of actions. Nothing was sent.`;
  }
  const intent = [...t.intents.values()][0] as IntentShape | null;
  if (!intent || !Array.isArray(intent.actions)) {
    return `this is not ${what}: it could not be read, so it was not paid for. Nothing was sent.`;
  }
  if (!emptyOffer(intent.dustActions, ['spends', 'registrations'])) {
    return `this is not ${what}: it already pays a network fee from somewhere else. Nothing was sent.`;
  }
  if (intent.actions.length !== 1) {
    return `this is not ${what}: it must call this vault's public deposit and nothing else. Nothing was sent.`;
  }
  const call = intent.actions[0] as {
    address?: unknown; entryPoint?: unknown;
    guaranteedTranscript?: { effects?: unknown } | null; fallibleTranscript?: { effects?: unknown } | null;
  } | null;
  if (!call || call.entryPoint === undefined || call.address === undefined
    || bare(call.address) !== bare(expect.vault) || nameOf(call.entryPoint) !== 'depositUnshielded') {
    return `this is not ${what}: it must call this vault's public deposit and nothing else. Nothing was sent.`;
  }
  /* What the call asks the transaction for, from its own declared effects. */
  const unreadable = `this is not ${what}: what it asks for could not be read, so it was not paid for. Nothing was sent.`;
  const asked = new Map<string, bigint>();
  let transcripts = 0;
  for (const transcript of [call.guaranteedTranscript, call.fallibleTranscript]) {
    if (transcript === undefined || transcript === null) continue;
    transcripts += 1;
    const e = transcript.effects as Record<string, unknown> | undefined | null;
    if (e === undefined || e === null) return unreadable;
    for (const k of ['claimedNullifiers', 'claimedShieldedReceives', 'claimedShieldedSpends', 'claimedContractCalls']) {
      if (!Array.isArray(e[k])) return unreadable;
      if ((e[k] as unknown[]).length !== 0) {
        return `this is not ${what}: the call asks for more than public money going into the vault. Nothing was sent.`;
      }
    }
    for (const k of ['shieldedMints', 'unshieldedMints', 'unshieldedOutputs', 'claimedUnshieldedSpends', 'unshieldedInputs']) {
      if (!(e[k] instanceof Map)) return unreadable;
      if (k !== 'unshieldedInputs' && (e[k] as Map<unknown, unknown>).size !== 0) {
        return `this is not ${what}: the call asks for more than public money going into the vault. Nothing was sent.`;
      }
    }
    for (const [type, value] of e.unshieldedInputs as Map<{ tag?: unknown; raw?: unknown } | null, unknown>) {
      if (type?.tag !== 'unshielded' || typeof value !== 'bigint') return unreadable;
      const k = bare(type.raw);
      asked.set(k, (asked.get(k) ?? 0n) + value);
    }
  }
  if (transcripts === 0) return unreadable;
  if (asked.size !== 1 || asked.get(bare(expect.token)) !== expect.amount) {
    return `this is not ${what}: it does not put exactly the token and amount asked for into the vault. Nothing was sent.`;
  }
  /* No private coin moves in a public deposit, in any part. */
  const shielded: ShieldedOfferShape[] = [];
  if (t.guaranteedOffer !== undefined && t.guaranteedOffer !== null) shielded.push(t.guaranteedOffer as ShieldedOfferShape);
  if (t.fallibleOffer !== undefined && t.fallibleOffer !== null) {
    if (!(t.fallibleOffer instanceof Map)) return unreadable;
    shielded.push(...[...t.fallibleOffer.values()] as ShieldedOfferShape[]);
  }
  if (!shielded.every((o) => emptyOffer(o, ['inputs', 'outputs', 'transients']))) {
    return `this is not ${what}: it moves private money as well, and a public deposit moves none. Nothing was sent.`;
  }
  /* The depositor's public coins in, and only change back to the depositor out. */
  const payers = new Set<string>();
  const outs: unknown[] = [];
  let spends = 0;
  for (const offer of [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer]) {
    if (offer === undefined || offer === null) continue;
    const o = offer as UnshieldedOfferShape;
    if (!Array.isArray(o.inputs) || !Array.isArray(o.outputs)) return unreadable;
    for (const input of o.inputs) {
      let address: string;
      try {
        address = bare(expect.addressOf((input as { owner?: unknown } | null)?.owner));
      } catch {
        return unreadable;
      }
      payers.add(address);
      spends += 1;
    }
    outs.push(...o.outputs);
  }
  if (spends === 0) {
    return `this is not ${what}: nobody's public money pays for it, so the depositor's wallet has not finished it. `
      + 'Nothing was sent and no money moved. Put the money in again from your wallet.';
  }
  for (const out of outs) {
    if (!payers.has(bare((out as { owner?: unknown } | null)?.owner))) {
      return `this is not ${what}: it pays public money to someone other than the vault and the depositor's own change. `
        + 'Nothing was sent.';
    }
  }
  if (typeof t.imbalances !== 'function') return unreadable;
  const segments = [...new Set([
    0, ...[...t.intents.keys()].map(Number),
    ...(t.fallibleOffer instanceof Map ? [...t.fallibleOffer.keys()].map(Number) : []),
  ])];
  for (const segment of segments) {
    let owed: Map<{ tag?: unknown }, bigint>;
    try {
      owed = t.imbalances(segment);
    } catch {
      return unreadable;
    }
    if (!(owed instanceof Map)) return unreadable;
    for (const [token, amount] of owed) {
      if (typeof amount !== 'bigint') return unreadable;
      if (token?.tag !== 'dust' && amount !== 0n) {
        return `this is not ${what}: it does not balance in its own money, and the company pays only the network `
          + 'fee. Nothing was sent and no money moved. Put the money in again from your wallet.';
      }
    }
  }
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

/* ------------------------------------------------- 5. a public payment out */

interface UnshieldedOfferShape { readonly inputs?: unknown; readonly outputs?: unknown }

/**
 * **`null` ONLY FOR A PUBLIC PAYMENT THAT MOVES THIS VAULT'S OWN PUBLIC MONEY
 * TO ONE PERSON AND NOTHING ELSE.**
 *
 * The same division as the private payout above: the account decides, inside
 * the transaction, whether the company approved the run, whether its window is
 * open and whether this person was already paid. What is decided here is only
 * whether the fee payer adds DUST to it. A public payment spends no coin of
 * anybody's: the vault releases its own public money to one public address, so
 * the transaction may carry exactly one public output, no public input, no
 * private coin at all, and no fee paid from anywhere else.
 */
export function refusalForPublicPayout(tx: unknown, expect: PayoutExpectations): string | null {
  const what = 'a public payment out of this company\'s vault';
  const t = tx as (TxShape & { imbalances?: (segment: number) => Map<{ tag?: unknown }, bigint> }) | null;
  if (!(t?.intents instanceof Map) || t.intents.size !== 1) {
    return `this is not ${what}: it must carry exactly one set of actions. Nothing was sent.`;
  }
  const intent = [...t.intents.values()][0] as IntentShape | null;
  if (!intent || !Array.isArray(intent.actions)) {
    return `this is not ${what}: it could not be read, so it was not paid for. Nothing was sent.`;
  }
  if (!emptyOffer(intent.dustActions, ['spends', 'registrations'])) {
    return `this is not ${what}: it already pays a network fee from somewhere else. Nothing was sent.`;
  }
  const called: string[] = [];
  for (const action of intent.actions) {
    const call = action as { address?: unknown; entryPoint?: unknown } | null;
    if (!call || call.entryPoint === undefined || call.address === undefined) {
      return `this is not ${what}: it does something other than call the vault and the account. Nothing was sent.`;
    }
    called.push(`${bare(call.address)}/${nameOf(call.entryPoint)}`);
  }
  const wanted = [`${bare(expect.account)}/recordPayment`, `${bare(expect.vault)}/payoutUnshielded`];
  if (called.length !== 2 || [...called].sort().join() !== [...wanted].sort().join()) {
    return `this is not ${what}: it must call this vault's public payout and this company's approval of it, and `
      + 'nothing else. Nothing was sent.';
  }
  /* No private coin moves in a public payment, in any part. */
  const shielded: ShieldedOfferShape[] = [];
  if (t.guaranteedOffer !== undefined && t.guaranteedOffer !== null) shielded.push(t.guaranteedOffer as ShieldedOfferShape);
  if (t.fallibleOffer !== undefined && t.fallibleOffer !== null) {
    if (!(t.fallibleOffer instanceof Map)) {
      return `this is not ${what}: its coins could not be read, so it was not paid for. Nothing was sent.`;
    }
    shielded.push(...[...t.fallibleOffer.values()] as ShieldedOfferShape[]);
  }
  if (!shielded.every((o) => emptyOffer(o, ['inputs', 'outputs', 'transients']))) {
    return `this is not ${what}: it moves private money as well, and a public payment moves none. Nothing was sent.`;
  }
  /* Nobody's public coin is spent, and the vault's money goes to exactly one address. */
  const publicOffers = [intent.guaranteedUnshieldedOffer, intent.fallibleUnshieldedOffer]
    .filter((o) => o !== undefined && o !== null) as UnshieldedOfferShape[];
  let outputs = 0;
  for (const offer of publicOffers) {
    if (!Array.isArray(offer.inputs) || !Array.isArray(offer.outputs)) {
      return `this is not ${what}: its public coins could not be read, so it was not paid for. Nothing was sent.`;
    }
    if (offer.inputs.length > 0) {
      return `this is not ${what}: it spends somebody's public coin, and a payment out of a vault spends none. `
        + 'Nothing was sent.';
    }
    outputs += offer.outputs.length;
  }
  if (outputs !== 1) {
    return `this is not ${what}: it must pay exactly one person. Nothing was sent.`;
  }
  if (typeof t.imbalances !== 'function') {
    return `this is not ${what}: what it moves could not be added up, so it was not paid for. Nothing was sent.`;
  }
  /*
   * **EVERY SEGMENT ANYTHING SITS IN, THE INTENT'S OWN INCLUDED.** The public
   * output rides on the intent, and a builder places an intent at a segment of
   * its own choosing, so a public output left unbalanced there is asked about
   * as well as the guaranteed part and every private fallible part.
   */
  const segments = [...new Set([
    0, ...[...t.intents.keys()].map(Number),
    ...(t.fallibleOffer instanceof Map ? [...t.fallibleOffer.keys()].map(Number) : []),
  ])];
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

/* --------------------------------------------- the one answer, for every door */

/**
 * **EVERYTHING A DOOR MUST HAVE READ BEFORE IT MAY ANSWER WHETHER MONEY GOES
 * INTO A VAULT.** Every field is a read of the chain as it is now, made by the
 * door: never a record this product keeps, because a check against our own
 * record is a check against our own claim.
 *
 * A read that failed is carried as the read's own four states rather than as a
 * boolean, so a door cannot turn *could not be asked* into *no*.
 */
export interface FundingFacts {
  /** What a refusal calls this vault to the person reading it. */
  readonly label: string;
  /**
   * **WHAT THE DOOR IS REFUSING, IN THE DOOR'S OWN WORDS**, and every sentence
   * below opens with it. One gate answers for a deposit and for the fee on a
   * payment out, and a person paying money OUT must not be told about money
   * going IN, so the consequence belongs to the door and the cause belongs
   * here. For example: `no money goes into vault 'x'`.
   */
  readonly what: string;
  /** Who holds the vault's rules. */
  readonly vault: AuthorityRead;
  /** The reading of the vault's circuits against this build's; `null` when they are this build's. */
  readonly vaultCircuits: string | null;
  /**
   * The account the vault's ledger is pinned to, or `null` when the vault's
   * state could not be read as a vault's.
   */
  readonly pinnedAccount: string | null;
  /** Who holds the rules of the account that vault pays out on. */
  readonly account: AuthorityRead;
  /** The reading of that account's circuits against this build's. */
  readonly accountCircuits: string | null;
  /** The account this vault must be pinned to for its money to be the company's. */
  readonly companyAccount: string;
  /**
   * **THE COMMITTEE THE COMPANY'S SIGNERS MAKE UP NOW, WHEN THE DOOR KNOWS IT.**
   *
   * `null` is the one deliberate difference between the doors and it is a
   * difference in what can be READ, not in what is required. A door serving a
   * signed-in person can open the company's roster and compare the chain against
   * it exactly. An operator tool has no roster, so it cannot tell a company that
   * deliberately has one signer from a vault nobody has handed over yet, and it
   * asks the stricter structural question instead: rules held by a committee of
   * at least two distinct keys, none of them this machine's. A vault a company
   * deliberately keeps at one key is therefore funded from the product and not
   * from an operator tool, and that is the stricter answer in both places.
   */
  readonly committee: Committee | null;
  /** The verifying keys of every maintenance key the door's own machine keeps. */
  readonly heldHere: readonly CommitteeKey[];
  /**
   * **WHAT THE CHAIN'S OWN HISTORY OF THE VAULT SAYS ABOUT EVERY CHANGE TO ITS
   * RULES**, read by the door only when the vault has been changed more than
   * once: `null` when that history vouches for every change
   * (`whyTheHistoryDoesNotVouch`), a sentence when it does not, and absent when
   * the door did not read it - and then a vault changed more than once is
   * refused, exactly as before any change after the handover could be made.
   */
  readonly vaultHistory?: string | null;
  /** The same, of the account the vault pays out on. */
  readonly accountHistory?: string | null;
}

/** Why no money goes in, and what kind of thing is in the way. */
export interface FundingRefusal {
  readonly why: string;
  /** The rules are held by keys that are not the company's: the handover is what resolves it. */
  readonly heldByOthers: boolean;
  /** Set when the thing in the way is the account rather than the vault. */
  readonly accountNotReady?: 'not-handed-over' | 'not-vouched' | 'unknown';
}

const holdsOneOf = (authority: OnChainAuthority, held: readonly CommitteeKey[]): boolean => {
  const ids = new Set(held.map((k) => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`));
  return authority.committee.some((k) => ids.has(`${k.tag.toLowerCase()}:${k.value.toLowerCase()}`));
};

/**
 * **THE QUESTION AN OPERATOR TOOL ASKS INSTEAD OF COMPARING WITH A ROSTER IT
 * CANNOT READ.** `null` only when the chain answers and shows rules held by a
 * committee of at least two distinct keys, none of them one this machine keeps.
 */
const structuralRefusal = (
  read: AuthorityRead, held: readonly CommitteeKey[], what: string, label: string, refusing: string,
): string | null => {
  if (read.state !== 'read') {
    return `${refusing}: the chain could not be asked who holds ${what} of '${label}' (${read.why}). `
      + 'Nothing was sent.';
  }
  const ours = holdsOneOf(read.authority, held);
  if (ours || read.authority.shape === 'one-key' || read.authority.shape === 'anyone') {
    return `${refusing}: ${what} of '${label}' are still held by `
      + `${ours ? 'a key this machine keeps' : 'a single key'} on the chain `
      + `(${read.authority.committee.length} key(s), threshold ${read.authority.threshold}), and whoever holds `
      + 'that key can change which proofs it accepts. Hand it to a committee nobody here holds a key of first. '
      + 'Nothing was sent.';
  }
  if (read.authority.shape !== 'committee' || read.authority.threshold < 2 || read.authority.hasDuplicateMembers) {
    const why = read.authority.shape === 'no-one'
      ? 'nobody can ever change its rules, so it could never be repaired or retired'
      : read.authority.hasDuplicateMembers
        ? 'its committee lists one key more than once, so its threshold is not what it reads as'
        : 'any one member of its committee can change which proofs it accepts';
    return `${refusing}: ${why}, for ${what} (${read.authority.committee.length} key(s), threshold `
      + `${read.authority.threshold}). Nothing was sent.`;
  }
  return null;
};

/** Held by exactly the committee the door read from the company's roster, or the sentence that says it is not. */
export const committeeHoldsIt = (
  read: AuthorityRead, to: Committee, what: string, whose: string, refusing = 'no money goes in',
): string | null => {
  const verdict = compareAuthority(read, {
    committee: to.committee.map((k) => ({ ...k })), threshold: to.threshold,
  });
  if (verdict.verdict === 'agree') return null;
  if (verdict.verdict === 'unknown') {
    return `${refusing}: the chain could not be asked who holds ${what}. Nothing was sent; try again when the `
      + 'chain answers.';
  }
  return `${refusing}: ${what} are not held by the company's committee on the chain. ${verdict.why} `
    + `If ${whose} was created here, finish handing it to the committee first. Nothing was sent.`;
};

/**
 * **CHANGED EXACTLY ONCE, WHICH IS THE HANDOVER - OR MORE OFTEN, WITH THE
 * CHAIN'S OWN HISTORY VOUCHING FOR EVERY CHANGE.** A contract whose committee
 * has changed since its handover has been changed more than once, and that is
 * the ordinary life of a company whose signers come and go. It is vouched for
 * only by its history, read off the chain (`whyTheHistoryDoesNotVouch`); a door
 * that did not read the history refuses it.
 */
const changedOnceRefusal = (
  read: AuthorityRead, what: string, refusing: string, history?: string | null,
): string | null => {
  if (read.state === 'read' && read.authority.counter === 1n) return null;
  if (read.state === 'read' && read.authority.counter > 1n && history === null) return null;
  const changes = read.state === 'read' ? String(read.authority.counter) : 'an unknown number of';
  if (read.state === 'read' && read.authority.counter > 1n) {
    return history === undefined
      ? `${refusing}: ${what} have been changed ${changes} times, and this service could not read the chain's record of `
        + 'those changes. Nothing was sent. Contact support.'
      : `${refusing}: ${what} have been changed ${changes} times, and the chain's record does not show that every change `
        + `was made safely. Nothing was sent. Contact support and quote this: ${history}.`;
  }
  return `${refusing}: ${what} have been changed ${changes} times, and one handed straight to its committee has `
    + 'been changed once, so what it accepts cannot be vouched for. Nothing was sent.';
};

/** One thing the chain did to a contract, as its history lists it, oldest first. */
export interface ContractHistoryStep {
  readonly kind: 'deploy' | 'call' | 'update';
  /** The transaction that did it. */
  readonly transaction: string;
  /** Who held the contract's rules in the state this step left. */
  readonly authority: AuthorityRead;
  /** The reading of that state's circuits against this build's: `null` when they are this build's. */
  readonly circuits: string | null;
}

/**
 * **WHETHER A CONTRACT'S HISTORY ON THE CHAIN VOUCHES FOR EVERY CHANGE TO ITS
 * RULES**, or the sentence saying why it does not.
 *
 * What changing a contract only once was protecting against: a key that held
 * the rules could replace a circuit, use it to rewrite what the contract holds,
 * put the circuit back and hand the rules on, and afterwards the chain would
 * show the right keys and this build's circuits. So, read off every state the
 * contract has been in:
 *
 *   1. it was created held by one key and never changed;
 *   2. every change after that moved its counter by exactly one, in order, up to
 *      the counter it holds now, so no change is missing from the history;
 *   3. the first change took the key it was created with off its rules, so that
 *      key made one change and let go;
 *   4. no transaction that changed its rules did anything else to it, so no
 *      circuit was called between two changes inside one transaction;
 *   5. every state a change left runs this build's circuits, so no replaced
 *      circuit was ever in force when a call could reach it.
 *
 * **HOW THE INDEXER SERVES A HISTORY, WHICH THIS IS WRITTEN AGAINST.** Every
 * change a transaction asked for is listed, whether or not it applied, and each
 * step carries the contract's state as its block left it, not as that one step
 * left it. So a change listed with the counter it found is one that did not
 * apply, and is passed over; and two changes applied in one block show as one
 * step whose counter moved by two, which this refuses, because what the
 * contract held between them cannot be read. A call's state says nothing about
 * the order within its block, so only the changes are counted.
 *
 * A history that cannot be read in full, or is in a shape this does not
 * recognise, does not vouch.
 */
export function whyTheHistoryDoesNotVouch(steps: readonly ContractHistoryStep[], now: AuthorityRead): string | null {
  if (now.state !== 'read') return `the chain could not be asked who holds it now (${now.why})`;
  if (steps.length === 0 || steps[0]!.kind !== 'deploy') return 'its history does not begin with it being created';
  if (steps.filter((s) => s.kind === 'deploy').length !== 1) return 'its history shows it created more than once';
  const created = steps[0]!.authority;
  if (created.state !== 'read') return `the state it was created with cannot be read (${created.why})`;
  if (created.authority.shape !== 'one-key' || created.authority.counter !== 0n) {
    return 'it was not created held by one key and never changed';
  }
  if (steps[0]!.circuits !== null) return `it was created with circuits other than this build's: ${steps[0]!.circuits}`;
  let counter = 0n;
  let first: Extract<AuthorityRead, { state: 'read' }> | undefined;
  for (const u of steps.filter((s) => s.kind === 'update')) {
    const change = counter + 1n;
    if (u.authority.state !== 'read') return `the state change ${change} left cannot be read (${u.authority.why})`;
    if (u.circuits !== null) return `change ${change} left it running circuits other than this build's: ${u.circuits}`;
    if (steps.filter((s) => s.transaction.toLowerCase() === u.transaction.toLowerCase()).length !== 1) {
      return `the transaction that made change ${change} also did something else to it`;
    }
    const at = u.authority.authority.counter;
    /* A change the chain did not apply leaves the counter where it found it. */
    if (at === counter) continue;
    if (at !== change) {
      return `its history goes from ${counter} change(s) to ${at} in one step, so a change is missing from the history `
        + 'or two were made at once';
    }
    counter = at;
    first ??= u.authority;
  }
  if (counter !== now.authority.counter) {
    return `its history shows ${counter} change(s) and the chain says it has been changed `
      + `${now.authority.counter} times, so the history is not complete`;
  }
  if (first === undefined) return 'its history shows no change at all';
  const createdWith = new Set(created.authority.committee.map((k) => `${k.tag.toLowerCase()}:${k.value.toLowerCase()}`));
  if (first.authority.committee.some((k) => createdWith.has(`${k.tag.toLowerCase()}:${k.value.toLowerCase()}`))) {
    return 'its first change left the key it was created with on its rules, so that key could have changed it again';
  }
  return null;
}

/**
 * **THE ONE ANSWER TO WHETHER MONEY MAY GO INTO A VAULT, AND EVERY DOOR ASKS
 * IT.** The product's deposit route, the record a payment out is vouched
 * against, and the operator funding tools all reach this function and nothing
 * else answers the question anywhere.
 *
 * **IT IS ONE LIST AND BOTH DOORS RUN ALL OF IT.** Before this existed the
 * operator tools asked about the vault's rules and nothing else, so a vault
 * handed to its committee while the account it pays out on was still held by a
 * temporary key on this machine was funded by a script and refused by the
 * screen. The account is what every vault pays out on, so every door now reads
 * it.
 *
 * **A VAULT IS FUNDED ONLY WHEN THE CHAIN SHOWS ALL OF THIS AT ONCE**, because
 * a key that held the rules before the handover could have swapped a circuit,
 * used it to rewrite the vault's ledger, put the circuit back and installed the
 * committee itself, and the chain would then show the committee and this
 * build's circuits:
 *
 *   1. the vault's rules are the company's committee, or, where no roster can
 *      be read, a committee of at least two keys none of which this machine
 *      holds;
 *   2. the vault's rules have been changed exactly once, or more often with
 *      the chain's own history vouching for every change;
 *   3. the vault runs this build's circuits, byte for byte;
 *   4. the vault is pinned to the company's own account;
 *   5. all of 1 to 3 again, of that account.
 *
 * The order is the order a person can act on: who holds it, then how often it
 * changed, then what it runs, then which account it answers to, then the same
 * of the account. A refusal names the first thing in the way and stops.
 */
export function refusalToPutMoneyIn(facts: FundingFacts): FundingRefusal | null {
  return asFarAsTheVault(facts) ?? andTheAccount(facts);
}

/**
 * **THE FIRST FOUR CONDITIONS, ABOUT THE VAULT ALONE.**
 *
 * Separate because one caller asks a narrower question and says so: whether the
 * COMMITTEE HOLDS THIS VAULT is what a device's handover waits on, and it is
 * answered without the account. It is never the question a door carrying money
 * asks, and every such door calls `refusalToPutMoneyIn` instead.
 */
export function asFarAsTheVault(facts: FundingFacts): FundingRefusal | null {
  const vaultRules = `the rules of vault '${facts.label}'`;
  const held = facts.committee === null
    ? structuralRefusal(facts.vault, facts.heldHere, 'the maintenance rules', facts.label, facts.what)
    : committeeHoldsIt(facts.vault, facts.committee, vaultRules, 'the vault', facts.what);
  /*
   * `heldByOthers` says the handover is what resolves this. A chain that could
   * not be asked is not resolved by a handover, so it is not that.
   */
  if (held !== null) return { why: held, heldByOthers: facts.vault.state === 'read' };

  const changed = changedOnceRefusal(facts.vault, vaultRules, facts.what, facts.vaultHistory);
  if (changed !== null) return { why: changed, heldByOthers: false };

  if (facts.vaultCircuits !== null) return { why: facts.vaultCircuits, heldByOthers: false };

  if (facts.pinnedAccount === null) {
    return {
      why: `${facts.what}: its state on the chain cannot be read as a vault's. Nothing was sent.`,
      heldByOthers: false,
    };
  }
  if (bare(facts.pinnedAccount) !== bare(facts.companyAccount)) {
    return {
      why: `${facts.what}: it is pinned to an account other than the company's, so money in it would be paid `
        + 'out on somebody else\'s approvals. Nothing was sent.',
      heldByOthers: false,
    };
  }

  return null;
}

/**
 * **THE ACCOUNT, WHICH IS WHAT EVERY VAULT PAYS OUT ON.** A vault held by the
 * company's committee is still paid out of by whoever holds the account's
 * rules, so a door that stops at the vault has asked half the question.
 */
function andTheAccount(facts: FundingFacts): FundingRefusal | null {
  const accountRules = 'the rules of this company\'s account, which every vault pays out on,';
  const kind = kindOfAccountTrouble(facts);
  const accountHeld = facts.committee === null
    ? structuralRefusal(
      facts.account, facts.heldHere, 'the rules of the account it pays out on', facts.label, facts.what)
    : committeeHoldsIt(facts.account, facts.committee, accountRules, 'the account', facts.what);
  if (accountHeld !== null) {
    /*
     * **AN ACCOUNT EXACTLY AS DEPLOYED IS NAMED AS THAT, AND NOT AS A
     * DISAGREEMENT**, because what resolves it is one press in the settings and
     * the person cannot act on a threshold comparison.
     */
    return {
      why: accountAsDeployed(facts)
        ? `${facts.what}: this company's account is still held by the temporary key it was created with, and a `
          + 'vault pays out on the account\'s approval. Hand the account to the company\'s committee in Settings '
          + 'first. Nothing was sent.'
        : accountHeld,
      heldByOthers: false,
      accountNotReady: kind,
    };
  }
  const accountChanged = changedOnceRefusal(facts.account, accountRules, facts.what, facts.accountHistory);
  if (accountChanged !== null) return { why: accountChanged, heldByOthers: false, accountNotReady: kind };
  if (facts.accountCircuits !== null) {
    return { why: facts.accountCircuits, heldByOthers: false, accountNotReady: kind };
  }
  return null;
}

/**
 * **WHICH OF THE THREE THINGS IS WRONG WITH THE ACCOUNT**, so a screen can
 * offer the handover rather than only reporting that money cannot go in. An
 * account the chain could not be asked about is `unknown`, and `unknown`
 * refuses like the rest.
 */
const kindOfAccountTrouble = (facts: FundingFacts): 'not-handed-over' | 'not-vouched' | 'unknown' =>
  facts.account.state !== 'read'
    ? 'unknown'
    : accountAsDeployed(facts) && facts.accountCircuits === null ? 'not-handed-over' : 'not-vouched';

/**
 * **THE ACCOUNT IS EXACTLY AS THIS SERVICE DEPLOYED IT**: one key, THIS
 * SERVICE'S OWN, never changed. What resolves that is one press in the
 * settings, so the refusal says so rather than quoting a threshold comparison
 * nobody can act on.
 *
 * **A DOOR THAT KEEPS NO KEY OF ITS OWN ANSWERS `false` HERE, AND MUST.** It
 * cannot tell whose single key the chain is showing, and *still held by the
 * temporary key it was created with* is a statement about custody. Answering
 * `true` on an empty list would tell a person their own handover is the missing
 * step while a stranger holds the account, and would show the screen the state
 * that offers the button rather than the one that raises an alarm.
 */
const accountAsDeployed = (facts: FundingFacts): boolean =>
  facts.account.state === 'read'
  && facts.account.authority.shape === 'one-key'
  && facts.account.authority.counter === 0n
  && facts.heldHere.length > 0
  && facts.account.authority.committee.every(
    (k) => facts.heldHere.some((h) => h.tag.toLowerCase() === k.tag.toLowerCase()
      && h.value.toLowerCase() === k.value.toLowerCase()));

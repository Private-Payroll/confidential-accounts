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
 *      company account's `recordPaymentFromVault` it asks, and nothing else,
 *      spending one coin the vault owns into one person's coin and at most one
 *      coin back to the vault, balanced in its own money so the fee payer adds
 *      only DUST;
 *   5. **the vault's start**: the company account's adoption round raised,
 *      approved and carried out, the first secret run raised and approved, each
 *      one call to the account that moves nothing; the secret set, which is the
 *      vault's `setNonceSecret` and the account's `approveVaultChange` and
 *      nothing else; and each sealed copy written, one call to the vault.
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
import type { OnChainAuthority } from '../midnight/ledger.js';
import type { Committee, CommitteeKey } from '../midnight/vault-committee.js';
import { sameCommittee } from '../midnight/vault-committee.js';
import { authorityIn, type ContractAuthority } from 'midnight-identity/profile/contract-authority';
import { whyNotInstallable } from 'midnight-identity/profile/request';
import { vaultBornHeldRefusal, type VaultBornHeldExpectations } from '../midnight/vault-circuits.js';
import { bare, emptyOffer, nameOf, theOnlyIntent, type DeployVerdict, type IntentShape, type TxShape } from '../midnight/account-deploy.js';
import { STEP_LIMITS } from '../midnight/payment-plan.js';

export { readAccountDeploy, type AccountDeployExpectations, type DeployVerdict } from '../midnight/account-deploy.js';

export { circuitsRefusal, startingLedgerFrom, type VaultStartingLedger } from '../midnight/vault-circuits.js';

/* ------------------------------------------------------------ 1. the deploy */

/** What the deploy of a vault born held must be: the company's account, the committee holding the company's rules, this build's circuits. */
export type VaultDeployExpectations = VaultBornHeldExpectations;


/**
 * **A NEW VAULT, READ BEFORE THE COMPANY PAYS TO SEND IT**: one deploy, moving
 * nothing, of a vault born held by the company's committee
 * (`vaultBornHeldRefusal`, the one reading a signer's device makes of the same
 * deploy before the vault is adopted).
 */
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
  const refusal = vaultBornHeldRefusal(deploy.initialState, expect, what);
  return refusal === null ? { vault: bare(deploy.address) } : { refusal };
}

/**
 * **THE SECOND STEP OF A COMPANY'S CREATION, AS THIS SERVICE READS IT BEFORE
 * IT PAYS.** One maintenance update and nothing else, to this company's
 * account, against counter 0, that is exactly the insert this service builds
 * itself from this build's keys - compared by the bytes a signer signs - and
 * signed once, at seat 0, by the founding signer's recorded key.
 */
export function refusalForCreationInsert(
  tx: unknown,
  expect: {
    readonly account: string;
    readonly foundingKey: CommitteeKey;
    /** What the signer signs, of the insert this service builds itself. */
    readonly expectedDataToSign: Uint8Array;
    readonly verify: (key: CommitteeKey, data: Uint8Array, signature: { tag: string; value: string }) => boolean;
  },
): string | null {
  const what = 'the second step of this company\'s account\'s creation';
  const only = theOnlyIntent(tx, what);
  if ('refusal' in only) return only.refusal;
  const update = (only.intent.actions as unknown[])[0] as {
    address?: unknown; counter?: unknown; signatures?: unknown; entryPoint?: unknown; dataToSign?: unknown; updates?: unknown;
  };
  if (update.entryPoint !== undefined || !Array.isArray(update.updates) || update.address === undefined) {
    return `this is not ${what}: it does something other than change the account's circuits. Nothing was sent.`;
  }
  if (bare(update.address) !== bare(expect.account)) return `this is not ${what}: it changes a different contract. Nothing was sent.`;
  if (update.counter !== 0n) return `this is not ${what}: it is built against a counter other than the account's first. Nothing was sent.`;
  const data = update.dataToSign;
  if (!(data instanceof Uint8Array) || data.length !== expect.expectedDataToSign.length
    || data.some((b, i) => b !== expect.expectedDataToSign[i])) {
    return `this is not ${what}: it inserts something other than exactly this build's remaining circuits. Nothing was sent.`;
  }
  const signatures = update.signatures;
  const one = Array.isArray(signatures) && signatures.length === 1 ? signatures[0] as [unknown, { tag: string; value: string }] : null;
  if (one === null || one[0] !== 0n || !expect.verify(expect.foundingKey, data, one[1])) {
    return `this is not ${what}: it is not signed once by the founding signer's own key. Nothing was sent.`;
  }
  return null;
}

/* ---------------------------------------------------------- 2. the handover */

/**
 * **WHO A CHANGE OF A CONTRACT'S RULES WOULD INSTALL**, read from the one
 * update it carries by the one reader of an authority (`authorityIn`) and
 * judged by `whyNotInstallable`, or the sentence that
 * refuses it. A key that is not a tagged string of hex digits, or a threshold
 * that is not a whole number, is refused by name rather than thrown.
 */
function installedBy(
  update: unknown, what: string, its: string,
): { readonly authority: ContractAuthority; readonly installs: Committee } | string {
  const read = authorityIn({ maintenanceAuthority: (update as { authority?: unknown } | null)?.authority });
  if ('why' in read) {
    return `this is not ${what}: it changes something other than who holds ${its} rules, because ${read.why.replace(/^the contract's /u, 'its ').replace(/\.$/u, '')}. `
      + 'Nothing was sent.';
  }
  const notInstallable = whyNotInstallable(read);
  if (notInstallable !== null) return `this is not a change of who holds the contract: ${notInstallable} Nothing was sent.`;
  return { authority: read, installs: { committee: read.committee.map((k) => ({ tag: k.tag, value: k.value })), threshold: read.threshold } };
}

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
      + `${expect.onChain.counter}, so the chain would refuse it: after charging the fee when its signatures still verify under `
      + 'the committee holding it now, and with no fee when they do not. Nothing was sent; '
      + 'build it again from what the chain holds now.';
  }
  if (update.updates.length !== 1) {
    return `this is not ${what}: it makes more than one change. Nothing was sent.`;
  }
  const installed = installedBy(update.updates[0], what, its);
  if (typeof installed === 'string') return installed;
  const { authority, installs } = installed;
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
 * **ONE CONTRACT'S COMMITTEE CHANGED, SIGNED BY THE COMMITTEE THAT HOLDS IT.**
 * Read as a stranger's transaction, whoever assembled it: one maintenance
 * update and nothing else, at the address asked for, replacing the whole
 * authority with exactly the committee asked for, against the counter the
 * chain holds now, carrying at least as many signatures as the committee on
 * the chain requires. The chain refuses a counter other than its own after the
 * transaction is included, and charges its fee, when its signatures still
 * verify under the committee holding the contract now; when they do not, it is
 * refused before inclusion with no fee. It refuses the rest - another
 * contract, too few signatures, a signature that does not verify, the wrong
 * installed counter - before inclusion, with no fee. Nothing here judges which
 * committee may be installed.
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
  const what = `${noun}'s committee changed`;
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
  if (update.counter !== expect.onChain.counter) {
    return `this change was built against counter ${String(update.counter)} and ${noun} is at `
      + `${expect.onChain.counter}, so the chain would refuse it: after charging the fee when its signatures still verify under `
      + 'the committee holding it now, and with no fee when they do not. Nothing was sent; '
      + 'build it again from what the chain holds now.';
  }
  if (update.updates.length !== 1) {
    return `this is not ${what}: it makes more than one change. Nothing was sent.`;
  }
  const installed = installedBy(update.updates[0], what, its);
  if (typeof installed === 'string') return installed;
  const { authority, installs } = installed;
  if (!sameCommittee(installs, expect.to)) {
    return `this is not ${what}: the keys or the threshold it installs are not the committee asked for. `
      + 'Nothing was sent.';
  }
  if (authority.counter !== expect.onChain.counter + 1n) {
    return `this is not ${what}: the authority it installs carries the wrong counter. Nothing was sent.`;
  }
  if (!Array.isArray(update.signatures) || update.signatures.length < expect.onChain.threshold) {
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
 * **HOW MANY OF THE VAULT'S OWN COINS ONE STEP OUT OF IT SPENDS, BY ITS KIND**:
 * the contract's own limits, read from the one place they are written. A batch
 * is one more case here when it is relayed.
 */
const COINS_A_STEP_SPENDS = {
  payment: { least: 1, most: STEP_LIMITS.paymentNotes },
  merge: { least: 2, most: STEP_LIMITS.mergeNotes },
} as const;

/** The refusal for a step whose coins in are not between its kind's limits, every one of them this vault's; null when they are. */
const coinsInRefusal = (
  kind: keyof typeof COINS_A_STEP_SPENDS, inputs: readonly ShieldedPart[], vault: string, what: string,
): string | null => {
  const { least, most } = COINS_A_STEP_SPENDS[kind];
  if (inputs.length < least || inputs.length > most || inputs.some((i) => ownerOf(i) !== bare(vault))) {
    return `this is not ${what}: it must spend ${['no', 'one', 'two'][least]} to ${most} coins, every one of them this `
      + 'vault\'s. Nothing was sent.';
  }
  return null;
};

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
   * and the account's `recordPaymentFromVault` it asks. The account is this company's:
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
  const wanted = [`${bare(expect.account)}/recordPaymentFromVault`, `${bare(expect.vault)}/payout`];
  if (called.length !== 2 || [...called].sort().join() !== [...wanted].sort().join()) {
    return `this is not ${what}: it must call this vault's payout and this company's approval of it, and `
      + 'nothing else. Nothing was sent.';
  }
  /*
   * **THE COINS: ONE OR TWO OF THE VAULT'S IN, ONE PERSON'S OUT, AND AT MOST ONE
   * BACK TO THE VAULT.** Read across the guaranteed part and every fallible part,
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
  /* One or two of the vault's notes: a payment may draw on a further note when one does not cover it. */
  const coinsIn = coinsInRefusal('payment', inputs, expect.vault, what);
  if (coinsIn !== null) return coinsIn;
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

/* ------------------------------------------- 5. a merge of the vault's own notes */


/**
 * **`null` ONLY FOR A MERGE OF THIS VAULT'S OWN NOTES INTO ONE COIN THE VAULT
 * KEEPS, AND NOTHING ELSE.**
 *
 * A merge needs no approval and moves nothing out of the vault: the vault
 * itself asserts every note is its own and of one token, and keeps one coin
 * worth all of them. What is decided here is only whether the fee payer adds
 * DUST to it: one call, the vault's `mergeNotes`; two to four coins in, every
 * one this vault's; exactly one coin out, back to this vault; no public money,
 * no fee from elsewhere, and nothing left unbalanced but the fee.
 */
export function refusalForMerge(tx: unknown, expect: { readonly vault: string }): string | null {
  const what = 'a merge of this vault\'s own notes';
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
    return `this is not ${what}: it moves public money, and a merge moves none. Nothing was sent.`;
  }
  if (!emptyOffer(intent.dustActions, ['spends', 'registrations'])) {
    return `this is not ${what}: it already pays a network fee from somewhere else. Nothing was sent.`;
  }
  const called: string[] = [];
  for (const action of intent.actions) {
    const call = action as { address?: unknown; entryPoint?: unknown } | null;
    if (!call || call.entryPoint === undefined || call.address === undefined) {
      return `this is not ${what}: it does something other than call the vault. Nothing was sent.`;
    }
    called.push(`${bare(call.address)}/${nameOf(call.entryPoint)}`);
  }
  if (called.length !== 1 || called[0] !== `${bare(expect.vault)}/mergeNotes`) {
    return `this is not ${what}: it must make exactly one call, this vault's mergeNotes, and nothing else. Nothing was sent.`;
  }
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
      return `this is not ${what}: it makes and spends a coin in one go, which a merge never does. Nothing was sent.`;
    }
    inputs.push(...offer.inputs as ShieldedPart[]);
    outputs.push(...offer.outputs as ShieldedPart[]);
  }
  const coinsIn = coinsInRefusal('merge', inputs, expect.vault, what);
  if (coinsIn !== null) return coinsIn;
  if (outputs.length !== 1 || ownerOf(outputs[0]!) !== bare(expect.vault)) {
    return `this is not ${what}: it must make exactly one coin, kept by this vault, and pay nobody. Nothing was sent.`;
  }
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

/* ------------------------------------------------- 6. a vault's start */

/** The calls one transaction makes, each as `address/circuit`, or a refusal when it is not calls that move nothing. */
const callsMovingNothing = (tx: unknown, what: string): { calls: string[] } | { refusal: string } => {
  const t = tx as TxShape | null;
  if (!(t?.intents instanceof Map) || t.intents.size !== 1) {
    return { refusal: `this is not ${what}: it must carry exactly one set of actions. Nothing was sent.` };
  }
  if (!emptyOffer(t.guaranteedOffer, ['inputs', 'outputs', 'transients'])
    || (t.fallibleOffer !== undefined && t.fallibleOffer !== null
      && (!(t.fallibleOffer instanceof Map) || [...t.fallibleOffer.values()].some(
        (o) => !emptyOffer(o, ['inputs', 'outputs', 'transients']))))) {
    return { refusal: `this is not ${what}: it moves coins, and starting a vault moves none. Nothing was sent.` };
  }
  const intent = [...t.intents.values()][0] as IntentShape | null;
  if (!intent || !emptyOffer(intent.guaranteedUnshieldedOffer, ['inputs', 'outputs'])
    || !emptyOffer(intent.fallibleUnshieldedOffer, ['inputs', 'outputs'])
    || !emptyOffer(intent.dustActions, ['spends', 'registrations'])) {
    return { refusal: `this is not ${what}: it moves coins, and starting a vault moves none. Nothing was sent.` };
  }
  if (!Array.isArray(intent.actions)) return { refusal: `this is not ${what}: it could not be read. Nothing was sent.` };
  const calls: string[] = [];
  for (const action of intent.actions) {
    const call = action as { address?: unknown; entryPoint?: unknown } | null;
    if (!call || call.entryPoint === undefined || call.address === undefined) {
      return { refusal: `this is not ${what}: it does something other than call a contract. Nothing was sent.` };
    }
    calls.push(`${bare(call.address)}/${nameOf(call.entryPoint)}`);
  }
  return { calls };
};

/** The account's circuits a vault's start calls on its own, each moving nothing. */
export type StartAccountCall = 'propose' | 'approve' | 'adopt';

/**
 * **ONE CALL TO THIS COMPANY'S ACCOUNT THAT A VAULT'S START MAKES, AND NOTHING
 * ELSE**: raising or approving the adoption round or the first secret run, or
 * carrying out the adoption. Which proposal it is, the account itself decides
 * inside the call, from what the signer's device proved.
 */
export function refusalForStartAccountCall(
  tx: unknown, expect: { readonly account: string; readonly circuit: StartAccountCall },
): string | null {
  const what = 'a step of this vault\'s start on the company\'s account';
  const read = callsMovingNothing(tx, what);
  if ('refusal' in read) return read.refusal;
  if (read.calls.length !== 1 || read.calls[0] !== `${bare(expect.account)}/${expect.circuit}`) {
    return `this is not ${what}: it must make exactly one '${expect.circuit}' call to this company's account, and `
      + 'nothing else. Nothing was sent.';
  }
  return null;
}

/** The account's circuits a company's creation calls to commit it to its pay-record key, each moving nothing. */
export type PayKeyCall = 'propose' | 'approve' | 'sealPayKey';

/**
 * **ONE CALL TO THIS COMPANY'S ACCOUNT THAT COMMITTING IT TO ITS PAY-RECORD KEY
 * MAKES, AND NOTHING ELSE**: raising or approving the proposal, or sealing the
 * key to a signer. Which round it is, and which key, the account itself checks
 * inside the call, from what the signer's device proved.
 */
export function refusalForPayKeyCall(tx: unknown, expect: { readonly account: string; readonly circuit: PayKeyCall }): string | null {
  const what = 'a step of committing this company\'s account to its pay-record key';
  const read = callsMovingNothing(tx, what);
  if ('refusal' in read) return read.refusal;
  if (read.calls.length !== 1 || read.calls[0] !== `${bare(expect.account)}/${expect.circuit}`) {
    return `this is not ${what}: it must make exactly one '${expect.circuit}' call to this company's account, and `
      + 'nothing else. Nothing was sent.';
  }
  return null;
}

/**
 * **THE VAULT'S SECRET SET, AND NOTHING ELSE**: the vault's `setNonceSecret` and
 * the account's `approveVaultChange` it asks. The account is this company's, so
 * the secret is set only on this company's approval.
 */
export function refusalForSetNonceSecret(tx: unknown, expect: { readonly vault: string; readonly account: string }): string | null {
  const what = 'this vault\'s secret being set';
  const read = callsMovingNothing(tx, what);
  if ('refusal' in read) return read.refusal;
  const wanted = [`${bare(expect.account)}/approveVaultChange`, `${bare(expect.vault)}/setNonceSecret`];
  if (read.calls.length !== 2 || [...read.calls].sort().join() !== [...wanted].sort().join()) {
    return `this is not ${what}: it must set this vault's secret and ask this company's approval of it, and nothing `
      + 'else. Nothing was sent.';
  }
  return null;
}

/** **ONE SEALED COPY WRITTEN INTO THIS VAULT, AND NOTHING ELSE.** */
export function refusalForSecretCopy(tx: unknown, expect: { readonly vault: string }): string | null {
  const what = 'a sealed copy of this vault\'s secret being written';
  const read = callsMovingNothing(tx, what);
  if ('refusal' in read) return read.refusal;
  if (read.calls.length !== 1 || read.calls[0] !== `${bare(expect.vault)}/writeSecretCopy`) {
    return `this is not ${what}: it must make exactly one 'writeSecretCopy' call to this vault, and nothing else. `
      + 'Nothing was sent.';
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
  const wanted = [`${bare(expect.account)}/recordPaymentFromVault`, `${bare(expect.vault)}/payoutUnshielded`];
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
 * INTO A VAULT.** Every field but the record of how each contract was created
 * is a read of the chain as it is now, made by the door.
 *
 * **NO COMMITTEE IS AMONG THEM.** Who holds a contract's rules is the super
 * admins' own matter: a signer joining or leaving, or a change of the super
 * admins that has reached some contracts and not others, never stops money
 * going in or out. A vault is the company's by the account it is pinned to.
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
  /** Whether the chain answered for the vault's state. Who holds its rules is never asked. */
  readonly vault: ContractAnswer;
  /** The reading of the vault's circuits against this build's; `null` when they are this build's. */
  readonly vaultCircuits: string | null;
  /**
   * The account the vault's ledger is pinned to, or `null` when the vault's
   * state could not be read as a vault's.
   */
  readonly pinnedAccount: string | null;
  /**
   * Whether the vault's ledger shows it started: a secret its account approved,
   * with every signer's sealed copy of it on the chain. `false` when it does not,
   * and when its state could not be read.
   */
  readonly started: boolean;
  /** Whether the chain answered for the state of the account that vault pays out on. Who holds its rules is never asked. */
  readonly account: ContractAnswer;
  /** The reading of that account's circuits against this build's. */
  readonly accountCircuits: string | null;
  /** The account this vault must be pinned to for its money to be the company's. */
  readonly companyAccount: string;
  /**
   * **WHETHER THIS SERVICE'S OWN RECORD HOLDS EACH CONTRACT AS BORN HELD**: its
   * deploy read, before this service paid for it, by the reader for its kind,
   * and found holding the company's committee at counter 0, running this
   * build's circuits and starting from the constructor's own state. From that
   * first transaction on, every change to its rules needed its committee's own
   * signatures, so nothing about its history is read: that one read is the
   * whole of what vouches for it.
   *
   * `null` at a door that keeps no such record, and then nothing is funded,
   * whoever the chain says holds it. It is never inferred from the chain: a
   * stranger can deploy a contract pinned to the company's account and held by
   * keys of their own, and only the record tells the two apart.
   */
  readonly bornHeld: { readonly vault: boolean; readonly account: boolean } | null;
}

/**
 * **WHETHER THE CHAIN ANSWERED FOR A CONTRACT'S STATE**, and nothing about who
 * holds its rules: the gate is handed this, never a read of a contract's
 * maintenance authority. `absent` when the chain answered and holds nothing
 * there; `unreachable` when it could not be asked.
 */
export type ContractAnswer =
  | { readonly state: 'answered' }
  | { readonly state: 'absent' | 'unreachable'; readonly why: string };

/** Why no money goes in, and what kind of thing is in the way. */
export interface FundingRefusal {
  readonly why: string;
  /** Always false: no refusal here is about who holds a contract, so none is resolved by a handover. */
  readonly heldByOthers: boolean;
  /** Set when the thing in the way is the account rather than the vault. */
  readonly accountNotReady?: 'not-handed-over' | 'not-vouched' | 'unknown';
  /**
   * Set when the vault is the company's in every other way and its start is
   * what is missing: adopted by the account, its first secret approved and every
   * sealed copy written. Creating the vault again from the device finishes it.
   */
  readonly notStarted?: true;
}

/** Why a contract the chain did not answer for is not funded, or null when it answered. */
const unansweredRefusal = (read: ContractAnswer, what: string, refusing: string): string | null =>
  read.state === 'answered' ? null
    : `${refusing}: the chain could not be asked about ${what} (${read.why}). Nothing was sent; try again when the chain answers.`;

/**
 * **BORN HELD BY THE COMPANY'S COMMITTEE, AS THIS SERVICE'S OWN RECORD SAYS.**
 * One rule for a vault and for the account. What it closes: a key that held a
 * contract's rules before its committee did could have swapped a circuit, used
 * it to rewrite what the contract holds, put the circuit back and installed the
 * committee itself, and afterwards the chain would show the right keys and this
 * build's circuits. A contract born held has had no such key, and the record is
 * the only thing that says a contract was born held.
 */
const bornHeldRefusal = (
  inTheRecord: boolean | null, what: string, refusing: string,
): string | null => {
  if (inTheRecord === true) return null;
  return inTheRecord === null
    ? `${refusing}: this tool keeps no record of how ${what} were created, and money goes only into a vault and an `
      + 'account this service read at their creation as held by the company\'s committee. Nothing was sent.'
    : `${refusing}: ${what} were not read by this service at their creation as held by the company's committee `
      + 'from their first transaction, so what they accepted before the committee held them cannot be vouched for. '
      + 'Nothing was sent.';
};

/**
 * **THE ONE ANSWER TO WHETHER MONEY MAY GO INTO A VAULT, AND EVERY DOOR ASKS
 * IT.** The product's deposit route and the fee on every payment out reach this
 * function, and nothing else answers the question anywhere.
 *
 * **A VAULT IS FUNDED ONLY WHEN ALL OF THIS IS TRUE AT ONCE**, read from the
 * chain except where it says the record:
 *
 *   1. the chain answered for the vault;
 *   2. this service's record holds the vault as born held;
 *   3. the vault runs this build's circuits, byte for byte;
 *   4. the vault is pinned to the company's own account;
 *   5. the vault is started: its account adopted it and approved a secret,
 *      and every signer's sealed copy of that secret is on the chain;
 *   6. 1 to 3 again, of that account.
 *
 * Who holds either contract's rules is not among them (`FundingFacts`). A
 * refusal names the first thing in the way and stops.
 */
export function refusalToPutMoneyIn(facts: FundingFacts): FundingRefusal | null {
  return asFarAsTheVault(facts) ?? andTheAccount(facts);
}

/**
 * **THE FIRST FIVE CONDITIONS, ABOUT THE VAULT ALONE.** It is never the question
 * a door carrying money asks, and every such door calls `refusalToPutMoneyIn`.
 */
export function asFarAsTheVault(facts: FundingFacts): FundingRefusal | null {
  return vaultIsTheCompanys(facts) ?? notStartedRefusal(facts);
}

/**
 * **THE FIRST FOUR: THE VAULT IS THE COMPANY'S** - answered for on the chain,
 * born held as this service's record says, running this build's circuits and
 * pinned to this company's account. Separate because a vault's start is raised
 * only once it is true, and the start itself is what answers the fifth.
 */
export function vaultIsTheCompanys(facts: FundingFacts): FundingRefusal | null {
  const vaultRules = `the rules of vault '${facts.label}'`;
  const unanswered = unansweredRefusal(facts.vault, vaultRules, facts.what);
  if (unanswered !== null) return { why: unanswered, heldByOthers: false };

  const born = bornHeldRefusal(facts.bornHeld === null ? null : facts.bornHeld.vault, vaultRules, facts.what);
  if (born !== null) return { why: born, heldByOthers: false };

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

/** The fifth: the vault is started. */
function notStartedRefusal(facts: FundingFacts): FundingRefusal | null {
  if (facts.started) return null;
  return {
    why: `${facts.what}: the company's account has not yet adopted it and approved its first secret, with every `
      + 'signer\'s sealed copy of that secret on the chain, and the vault itself takes no money until then. '
      + 'Nothing was sent.',
    heldByOthers: false,
    notStarted: true,
  };
}

/**
 * **THE ACCOUNT, WHICH IS WHAT EVERY VAULT PAYS OUT ON**: answered for on the
 * chain, born held as this service's record says, and running this build's
 * circuits. An account the chain could not be asked about is `unknown`.
 */
function andTheAccount(facts: FundingFacts): FundingRefusal | null {
  const accountRules = 'the rules of this company\'s account, which every vault pays out on,';
  const unanswered = unansweredRefusal(facts.account, accountRules, facts.what);
  if (unanswered !== null) return { why: unanswered, heldByOthers: false, accountNotReady: 'unknown' };
  const accountBorn = bornHeldRefusal(facts.bornHeld === null ? null : facts.bornHeld.account, accountRules, facts.what);
  if (accountBorn !== null) return { why: accountBorn, heldByOthers: false, accountNotReady: 'not-vouched' };
  if (facts.accountCircuits !== null) {
    return { why: facts.accountCircuits, heldByOthers: false, accountNotReady: 'not-vouched' };
  }
  return null;
}

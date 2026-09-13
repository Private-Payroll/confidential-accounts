/**
 * **THE RULES OF THE DOOR THAT PAYS MONEY OUT OF A VAULT, WITH NOTHING IN THEM
 * THAT REACHES A NETWORK.**
 *
 * `scripts/pay-from-vault.ts` is the door. It proves, submits and spends, so
 * what it decides is kept here, where it can be driven and checked without a
 * chain: what a person typed, which step comes next, how the one payment and
 * the run it belongs to are built, and what the balance afterwards means.
 *
 * A payment out of a vault is never the vault's decision alone. `payoutUnshielded`
 * asks the account, and the account refuses unless four things hold: an open
 * proposal whose identity is this run's, approvals at the vault's threshold, a
 * block time inside the run's window, and a merkle path from this payee's leaf
 * to the approved root. It also refuses a leaf it has already paid. So the door
 * is a sequence (propose, approve, pay) and a person can stop between any two
 * steps and run it again. `nextStep` is what makes that safe: it reads the
 * chain's answer to each of those questions and never a local belief about them.
 */
import { createHash } from 'node:crypto';

import type { Asset } from '../src/core/assets.js';
import type { Hex } from '../src/core/crypto.js';
import type { ProposalAsks } from '../src/core/vault-holdings.js';
import type { VaultEntry } from '../src/midnight/vault-record.js';
import type { Payee } from '../src/midnight/payee-address.js';
import { VaultCannotAfford, type VaultPayment } from '../src/midnight/vault-ledger.js';
import {
  buildRun, type DetailsOfKind, type PaymentFacts, type PayeeArgs, type PayrollRun,
} from '../src/midnight/payout-tree.js';

const HEX32 = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ *
 * what a person typed
 * ------------------------------------------------------------------ */

/** The amount, digits only, in the asset's smallest unit. No default and no conversion. */
export function amountFromText(text: string): bigint {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    throw new Error(
      'no amount was given. The door asks how much and passes the answer here. '
      + 'There is deliberately no default: a default amount is money nobody decided to move.');
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `"${trimmed}" is not an amount this door will take. Digits and nothing else: no point, no `
      + 'separators, no sign. The amount is in the smallest unit, which is what the contract takes '
      + 'and what the chain publishes, and nothing here converts between units.');
  }
  const amount = BigInt(trimmed);
  if (amount <= 0n) throw new Error('a payment has to move a positive amount. Give an amount above 0.');
  return amount;
}

/** What the company calls this payment. Required, so it can be recognised later. */
export function referenceFromText(text: string): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    throw new Error(
      'this payment has no reference. Give it one, so it can be recognised later: a payment in '
      + 'a company\'s records with no name on it is the one nobody can account for later.');
  }
  return trimmed;
}

/** The payee must be a PUBLIC address: this door pays out of a vault's public balance. */
export function assertPublicPayee(payee: Payee): Payee & { kind: 'unshielded' } {
  if (payee.kind === 'unshielded') return payee;
  throw new Error(
    'that is a private address, and this door pays out of a vault\'s public balance. A private '
    + 'payment spends a note through a different circuit. Give a public address, the kind that '
    + 'begins mn_addr_.');
}

/* ------------------------------------------------------------------ *
 * the records on disk
 * ------------------------------------------------------------------ */

/** The vault must carry the public payment circuit. */
export function assertVaultCanPayPublicly(entry: VaultEntry): void {
  const circuits = Array.isArray(entry.circuits) ? entry.circuits : [];
  if (circuits.includes('payoutUnshielded')) return;
  throw new Error(
    `the record for the vault "${entry.name}" does not list payoutUnshielded, so it cannot make a `
    + `public payment. It lists: ${circuits.length ? circuits.join(', ') : '(nothing)'}. A vault `
    + 'deployed before the public path existed cannot be given it; DEPLOY-VAULT.command deploys one '
    + 'that can.');
}

/**
 * The vault must be married to the account deployed now. A vault pins its account
 * when it is built and cannot be pointed at another, so every payment it makes is
 * authorised by that account or by nothing.
 */
export function assertVaultIsMarriedTo(entry: VaultEntry, account: { contractAddress?: unknown } | null): void {
  const deployed = String(account?.contractAddress ?? '').trim().toLowerCase();
  const pinned = String(entry.accountAddress ?? '').trim().toLowerCase();
  if (deployed && pinned && deployed === pinned) return;
  throw new Error(
    `the vault "${entry.name}" is married to an account that is not the one deployed on this `
    + 'network, and a vault can never be pointed at another account. No payment out of it can '
    + 'ever be authorised. Pay from a vault deployed against the account that is deployed now. '
    + 'Neither address is printed here.');
}

/* ------------------------------------------------------------------ *
 * the window, in seconds
 * ------------------------------------------------------------------ */

/** The latest moment the account accepts as a window end, in seconds. A larger number is milliseconds. */
export const LATEST_WINDOW_END = 32_503_680_000n;
/** How far before the moment it is recorded the window opens. */
export const OPENS_BEFORE_NOW = 600n;
/** How long after the moment it is recorded the window stays open. */
export const STAYS_OPEN_FOR = 86_400n;

/**
 * **THE RUN'S WINDOW OPENS TEN MINUTES BEFORE IT IS WRITTEN DOWN, AND CLOSES A DAY
 * AFTER.**
 *
 * The account refuses a payment whose block time is before the window opens.
 * A window that opens at the moment of writing depends on the chain's clock
 * having reached this machine's, which it may not have; ten minutes in the past
 * removes that wait. The cost is stated: a run whose window has opened can no
 * longer be withdrawn, only swept once it closes, which for a single payment a
 * person is about to make is the right trade.
 */
export function windowAt(nowSeconds: bigint): { opensAt: bigint; closesAt: bigint } {
  if (nowSeconds <= OPENS_BEFORE_NOW) throw new Error(`${nowSeconds} is not a time in seconds`);
  const closesAt = nowSeconds + STAYS_OPEN_FOR;
  if (closesAt > LATEST_WINDOW_END) {
    throw new Error(
      `${nowSeconds} is a time in milliseconds, not seconds. The account compares block time in `
      + 'seconds, so a window written in milliseconds never closes and never matches.');
  }
  return { opensAt: nowSeconds - OPENS_BEFORE_NOW, closesAt };
}

/** Block time, as the account compares it: whole seconds. The indexer publishes milliseconds. */
export const blockSecondsOf = (timestampMs: number): bigint => {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    throw new Error(`the chain's latest block time came back as ${String(timestampMs)}, which is not a time`);
  }
  return BigInt(Math.floor(timestampMs / 1000));
};

/* ------------------------------------------------------------------ *
 * the record this door keeps between runs
 * ------------------------------------------------------------------ */

/**
 * **WHAT A PERSON ASKED FOR, AND EVERYTHING NEEDED TO FINISH IT, WRITTEN BEFORE
 * THE FIRST FEE.**
 *
 * A run is identified on chain by its root, its window and a salt, and a payment
 * needs the leaf's blinding and nonce. None of those can be read back from the
 * chain. If the door stopped after the approvals and before the payment, a door
 * that had not written them down would hold an approved proposal nobody could
 * ever pay. So the record is written before the proposal is raised, and a second
 * run with the same answers finishes the first rather than starting another.
 *
 * `seed` is this door's own, not the account's payout seed: the stagenet account
 * this door pays from has none recorded on this machine. The leaf secrets are
 * derived from it by the same `buildRun` the product uses, so the run is built the
 * product's way from a seed that only this record holds.
 */
export interface PayoutRecord {
  readonly format: 1;
  readonly network: string;
  readonly vault: string;
  readonly payTo: string;
  readonly amount: string;
  readonly reference: string;
  readonly seed: Hex;
  readonly salt: Hex;
  readonly runId: string;
  readonly opensAt: string;
  readonly closesAt: string;
  readonly createdAt: string;
  /**
   * **WHICH ASSET, AND WHICH LEDGER TOKEN, THE APPROVALS WERE GATHERED FOR.**
   *
   * **ABSENT ON RECORDS WRITTEN BEFORE THEY WERE KEPT**, which is why they are
   * optional and why a record without them resumes exactly as it used to.
   *
   * They are kept because a leaf commits to the TOKEN, so two runs of one
   * record under two tokens are two different leaves and therefore two
   * different proposals - and the account's guarantee is per leaf, so it does
   * not refuse the second. A door whose asset is a literal cannot reach that;
   * one that derives it from a registry can, the moment the registry's answer
   * changes between two runs of the same record.
   */
  readonly asset?: string;
  readonly token?: string;
}

export interface PaymentAsk {
  readonly network: string;
  readonly vault: string;
  readonly payTo: string;
  readonly amount: bigint;
  readonly reference: string;
  /** What this run would settle in. Recorded, and compared when a record carries it. */
  readonly asset?: string;
  readonly token?: string;
}

export function newPayoutRecord(
  ask: PaymentAsk, fresh32: () => Hex, nowSeconds: bigint, nowIso: string,
): PayoutRecord {
  const seed = fresh32();
  const salt = fresh32();
  if (!HEX32.test(seed) || !HEX32.test(salt) || seed === salt) {
    throw new Error('the random source did not give two different 32-byte values, so no run was written');
  }
  const { opensAt, closesAt } = windowAt(nowSeconds);
  return {
    format: 1, network: ask.network, vault: ask.vault, payTo: ask.payTo,
    amount: ask.amount.toString(), reference: ask.reference,
    seed, salt, runId: `payout:${nowIso}`, opensAt: opensAt.toString(), closesAt: closesAt.toString(),
    createdAt: nowIso,
    ...(ask.asset === undefined ? {} : { asset: ask.asset }),
    ...(ask.token === undefined ? {} : { token: ask.token }),
  };
}

/** A record's text as read from disk. Text a write cut short leaves is refused by name, like any other damage. */
export function payoutRecordFromText(text: string, where: string): PayoutRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(
      `${where} is not a payment record this door can finish: it is not whole JSON, which is what a write `
      + 'cut short leaves. It is left where it is. A record is written before anything is proposed, so if '
      + 'this run of the door never got past writing it, nothing was proposed from it: move it aside and run '
      + 'the door again.');
  }
  return parsePayoutRecord(raw, where);
}

/**
 * **THE SAME PAYMENT, ALREADY MADE, IS NOT STARTED AGAIN BY ACCIDENT.**
 *
 * A finished record is kept beside the live one. If a person asks for exactly the
 * payment a finished record made (the same vault, address, amount and reference)
 * while that record's window is still open, the likeliest reason is a second copy
 * of the door that stopped after the first had paid, and a person following its
 * advice to run again. Refused, naming what makes a deliberate second payment
 * possible: a different reference.
 */
export function assertNotAlreadyPaid(finished: readonly PayoutRecord[], ask: PaymentAsk, nowSeconds: bigint): void {
  const same = finished.find((r) => r.network === ask.network && r.vault === ask.vault && r.payTo === ask.payTo
    && r.amount === ask.amount.toString() && r.reference === ask.reference && BigInt(r.closesAt) > nowSeconds);
  if (!same) return;
  throw new Error(
    `this exact payment (the same address, amount and reference out of this vault) was already paid by a run `
    + `recorded ${same.createdAt}, and nothing was proposed, approved or paid by this run. If it is meant to be `
    + 'paid a second time, give it a different reference.');
}

/**
 * Where a finished record is kept, beside the live one. The live record's name
 * with `.paid-<the moment it was written>` before `.json`, so every finished record
 * of one vault starts with the same prefix and `assertNotAlreadyPaid` can find it.
 */
export const finishedRecordFile = (liveFile: string, record: PayoutRecord): string => {
  if (!liveFile.endsWith('.json')) throw new Error(`${liveFile} is not a record file`);
  return `${liveFile.slice(0, -'.json'.length)}.paid-${record.createdAt.replace(/[^0-9A-Za-z]/g, '')}.json`;
};

/** The prefix every finished record of a live record file starts with. */
export const finishedRecordPrefix = (liveFileName: string): string => {
  if (!liveFileName.endsWith('.json')) throw new Error(`${liveFileName} is not a record file`);
  return `${liveFileName.slice(0, -'.json'.length)}.paid-`;
};

/** A record read back from disk, or a refusal naming what is wrong with it. Never a guess. */
export function parsePayoutRecord(raw: unknown, where: string): PayoutRecord {
  const r = raw as Record<string, unknown> | null;
  const bad = (why: string): never => {
    throw new Error(
      `${where} is not a payment record this door can finish: ${why}. It is left where it is. If `
      + 'no payment was ever raised from it, move it aside and run the door again.');
  };
  if (r === null || typeof r !== 'object') bad('it is not an object');
  if (r!.format !== 1) bad(`its format is ${JSON.stringify(r!.format)}, not 1`);
  for (const k of ['network', 'vault', 'payTo', 'reference', 'runId', 'createdAt'] as const) {
    if (typeof r![k] !== 'string' || !(r![k] as string)) bad(`it has no ${k}`);
  }
  /* Optional, because records written before they were kept have neither. Present means usable. */
  for (const k of ['asset', 'token'] as const) {
    if (r![k] !== undefined && (typeof r![k] !== 'string' || !(r![k] as string))) {
      bad(`its ${k} is present and is not a usable value`);
    }
  }
  for (const k of ['seed', 'salt'] as const) {
    if (typeof r![k] !== 'string' || !HEX32.test(r![k] as string)) bad(`its ${k} is not 32 bytes of lower-case hex`);
  }
  for (const k of ['amount', 'opensAt', 'closesAt'] as const) {
    if (typeof r![k] !== 'string' || !/^[0-9]+$/.test(r![k] as string)) bad(`its ${k} is not digits`);
  }
  if (BigInt(r!.opensAt as string) >= BigInt(r!.closesAt as string)) bad('its window closes before it opens');
  return r as unknown as PayoutRecord;
}

/**
 * **A RECORD IS FINISHED WITH THE ANSWERS IT WAS WRITTEN FOR, OR NOT AT ALL.**
 *
 * The approvals already gathered for a record are approvals for its payee and
 * its amount. Finishing it with a different amount typed at the prompt would
 * pay what the signers approved while the person believed they had asked for
 * something else. So a difference is refused, naming every field that differs.
 */
export function assertRecordIsThisPayment(
  record: PayoutRecord,
  ask: PaymentAsk,
  /**
   * **WHETHER A RECORD THAT NAMES NO ASSET MAY BE FINISHED AT ALL.**
   *
   * **DEFAULT YES, AND A DOOR THAT DERIVES ITS ASSET MUST SAY NO.** A leaf
   * commits to the token, so a record finished under a different one builds a
   * different leaf, a different proposal, and a second payable run the account
   * has never seen. Records written before the token was kept name neither,
   * so on a door whose asset can change between two runs there is nothing to
   * compare and nothing to be sure of.
   *
   * A door whose asset is a literal and whose token is a constant cannot reach
   * that, and refusing its old records would strand a payment that is perfectly
   * safe to finish - with its proposal open and approved on chain, which is the
   * expensive half already paid for. So it is per door, argued at each call
   * site, and the answer that needs no argument is the strict one.
   */
  theAssetCanChangeBetweenRuns = true,
): void {
  const differs: string[] = [];
  if (record.network !== ask.network) differs.push(`network (recorded ${record.network}, asked ${ask.network})`);
  if (record.vault !== ask.vault) differs.push(`vault (recorded "${record.vault}", asked "${ask.vault}")`);
  if (record.payTo !== ask.payTo) differs.push('the address paid');
  if (record.amount !== ask.amount.toString()) differs.push(`amount (recorded ${record.amount}, asked ${ask.amount})`);
  if (record.reference !== ask.reference) differs.push(`reference (recorded "${record.reference}", asked "${ask.reference}")`);
  /*
   * **THE ASSET AND THE TOKEN, WHEN THE RECORD CARRIES THEM.**
   *
   * A leaf commits to the token, so finishing a record under a different one
   * builds a different leaf, a different proposal, and a run that proposes a
   * SECOND time while the first proposal is open, approved and payable. The
   * account records payments per leaf, so it does not refuse it.
   *
   * A record written before these were kept carries neither, and resumes as it
   * always did: comparing an absent value against a present one would refuse
   * every record that predates this.
   */
  if (record.asset !== undefined && ask.asset !== undefined && record.asset !== ask.asset) {
    differs.push(`asset (recorded ${record.asset}, asked ${ask.asset})`);
  }
  if (record.token !== undefined && ask.token !== undefined && record.token !== ask.token) {
    differs.push('the ledger token this settles in, which is what the approved leaf commits to');
  }
  /*
   * **A RECORD THAT NAMES NEITHER CANNOT BE PROVED TO BE THIS PAYMENT.** It was
   * written before the token was kept, and on a door that derives its asset the
   * registry may have answered differently then. Comparing nothing against
   * something is not a comparison, and the run that follows a passed comparison
   * proposes.
   */
  if (theAssetCanChangeBetweenRuns && ask.token !== undefined && record.token === undefined) {
    differs.push(
      'the recorded payment names no asset and no ledger token, so it was written before those '
      + 'were kept and there is nothing here that says it settles in the same money this run '
      + 'would. A payment\x27s approved leaf commits to its token');
  }
  if (differs.length === 0) return;
  throw new Error(
    `there is already an unfinished payment out of this vault, and it is not the one asked for now: `
    + `${differs.join('; ')}. Nothing was proposed, approved or paid by this run. Finish the `
    + 'recorded payment by running the door again with its answers, or let its window close and '
    + 'start again afterwards. DO NOT MOVE THE RECORD ASIDE TO '
    + 'START ANOTHER WHILE ITS WINDOW IS OPEN: if it was already approved, it stays payable until the '
    + 'window closes, and a new record is a new payment, so the same money could be paid twice. Once '
    + 'its window has closed, this door refuses the old record and says so.');
}

/* ------------------------------------------------------------------ *
 * the run and the payment
 * ------------------------------------------------------------------ */

/**
 * The one-payee run this record describes, built by the product's own `buildRun`,
 * and the arguments the vault needs to pay it. Deterministic: the same record
 * builds the same root, leaf and path every time it is read.
 */
export function runOf(
  record: PayoutRecord, facts: PaymentFacts, detailsOf: DetailsOfKind, accountId: string,
): { run: PayrollRun; args: PayeeArgs; opensAt: bigint; closesAt: bigint } {
  if (facts.amount.toString() !== record.amount) {
    throw new Error(`the payment built pays ${facts.amount} and the record says ${record.amount}; nothing was built`);
  }
  const run = buildRun(
    [{ epoch: 0, seed: record.seed }], { accountId, runId: record.runId, epoch: 0 }, [facts], detailsOf);
  return { run, args: run.payeeArgs(0), opensAt: BigInt(record.opensAt), closesAt: BigInt(record.closesAt) };
}

/** What the vault is handed to make the payment. Every field from the run and the record. */
export function vaultPaymentOf(
  record: PayoutRecord, built: ReturnType<typeof runOf>, proposalId: Hex,
): VaultPayment {
  const { run, args, opensAt, closesAt } = built;
  return {
    proposal: proposalId,
    root: run.tree.root,
    payees: run.tree.payees,
    opensAt,
    closesAt,
    salt: record.salt,
    payee: args.payee,
    token: args.token,
    amount: args.amount,
    blinding: args.blinding,
    nonce: args.nonce,
    path: args.path,
  };
}

/**
 * **WHAT THE HOLDINGS CHECK IS ASKED, IN THE SHAPE THE ACCOUNT SERVICE ASKS IT.**
 * One payment, one payee, the payment's own token and amount, so the check a
 * product raise makes and the check this door makes are the same function over
 * the same question.
 */
export function asksOf(vaultAddress: string, asset: Asset, facts: PaymentFacts): ProposalAsks {
  return {
    vault: vaultAddress,
    asset,
    total: facts.amount,
    payees: 1n,
    payments: [{ payee: { kind: facts.payee.kind }, token: facts.token, amount: facts.amount }],
  };
}

/** The change a proposal commits to has a batch digest; for this payment it is the digest of its record. */
export const batchDigestOf = (record: PayoutRecord): Hex =>
  createHash('sha256').update(JSON.stringify(record)).digest('hex') as Hex;

/* ------------------------------------------------------------------ *
 * what the chain says, and what comes next
 * ------------------------------------------------------------------ */

/**
 * How many approvals a payment from this vault needs: the vault's own threshold
 * if the account has one seated for it, otherwise the account's.
 */
export function approvalsNeeded(accountThreshold: bigint, vaultThreshold: bigint | null): bigint {
  const needed = vaultThreshold ?? accountThreshold;
  if (needed < 1n) throw new Error(`the account reports a threshold of ${needed}, which no approval can meet`);
  return needed;
}

export interface ChainFacts {
  /** The chain's movement set holds this payee's leaf. */
  readonly paid: boolean;
  /** The account holds an open proposal with this run's identity. */
  readonly proposalOpen: boolean;
  /** Approvals the chain counts for it, 0 when it is not open. */
  readonly approvals: bigint;
  readonly needed: bigint;
  /** The latest block's time, in seconds. */
  readonly blockSeconds: bigint;
  readonly opensAt: bigint;
  readonly closesAt: bigint;
}

export type Step = 'paid' | 'window-closed' | 'propose' | 'approve' | 'window-not-open' | 'pay';

/**
 * **THE NEXT THING TO DO, DECIDED FROM THE CHAIN ALONE.**
 *
 * In this order, and the order is the safety:
 *
 *   1. paid          the account has recorded this leaf, so paying again is refused
 *                    by the chain and would burn a fee. Nothing more to do.
 *   2. window-closed no payment can fall inside a window that has closed.
 *   3. propose       no open proposal has this run's identity.
 *   4. approve       fewer approvals than the vault's threshold.
 *   5. window-not-open  the chain's clock has not reached the window yet.
 *   6. pay
 */
export function nextStep(f: ChainFacts): Step {
  if (f.paid) return 'paid';
  if (f.blockSeconds >= f.closesAt) return 'window-closed';
  if (!f.proposalOpen) return 'propose';
  if (f.approvals < f.needed) return 'approve';
  if (f.blockSeconds < f.opensAt) return 'window-not-open';
  return 'pay';
}

/**
 * Which signer approves next. Signers approve in a fixed order, so when the chain
 * counts `have` approvals the ones already given are the first `have`. That holds
 * only while nobody else approves this proposal, and the door says so.
 */
export function nextApprover<T extends string>(have: bigint, order: readonly T[]): T {
  const i = Number(have);
  if (!Number.isSafeInteger(i) || i < 0 || i >= order.length) {
    throw new Error(
      `this proposal needs approval number ${have + 1n} and this machine holds ${order.length} `
      + 'signers. The approvals it lacks have to come from signers whose keys are not here.');
  }
  return order[i];
}

export type PublicMovement = 'left-the-vault' | 'did-not-move' | 'moved-by-a-different-amount' | 'not-read';

/**
 * **WHAT TWO READS OF THE VAULT'S PUBLIC BALANCE SAY ABOUT THE PAYMENT.**
 *
 * Only an exact fall by the amount is `left-the-vault`. Any other difference is
 * named as what it is: the balance is one number that a deposit or another
 * payment between the reads also moves, so a different difference is not a
 * failure of this payment and not a success of it either.
 */
export function publicMovementOf(before: bigint | null, after: bigint | null, amount: bigint): PublicMovement {
  if (before === null || after === null) return 'not-read';
  if (before - after === amount) return 'left-the-vault';
  if (before === after) return 'did-not-move';
  return 'moved-by-a-different-amount';
}

/* ------------------------------------------------------------------ *
 * the sequence
 * ------------------------------------------------------------------ */

/** What the door does to the world. Each is one read or one transaction, and nothing decides here. */
export interface DoorActions<Signer extends string> {
  readChain(): Promise<ChainFacts>;
  /** Refuses, before anything is proposed, if the vault does not hold the payment. */
  holdsTheMoney(): Promise<void>;
  /** Refuses, before the payment, if the vault no longer holds it. */
  stillHoldsTheMoney(): Promise<void>;
  propose(): Promise<string>;
  approve(as: Signer): Promise<string>;
  pay(): Promise<string>;
  wait(ms: number): Promise<void>;
  say(line: string): void;
}

export interface DriveLimits {
  /** How many decisions one run may take before it stops and says so. */
  readonly steps: number;
  /** How many times the chain is read after a transaction before giving up on seeing it. */
  readonly polls: number;
  readonly pollMs: number;
  readonly notOpenYetMs: number;
}

export const DOOR_LIMITS: DriveLimits = { steps: 12, polls: 18, pollMs: 10_000, notOpenYetMs: 30_000 };

/**
 * **THE DOOR'S WHOLE SEQUENCE: READ THE CHAIN, DO THE ONE STEP IT CALLS FOR, AND
 * DO NOT MOVE ON UNTIL THE CHAIN SHOWS IT.**
 *
 * Three properties hold here and nowhere else:
 *
 *   · the vault is asked whether it holds the money before a proposal and again
 *     before the payment, and a refusal from either stops the run before that
 *     transaction;
 *   · after a transaction, the chain is read until it shows the effect. The
 *     indexer can answer with the state from before a transaction that has
 *     landed, and deciding again from that would propose twice or approve twice,
 *     each a fee for a transaction the chain refuses. If the effect never shows,
 *     the run stops with nothing further submitted;
 *   · a leaf the account has recorded as paid is never paid again.
 */
export async function drive<Signer extends string>(
  act: DoorActions<Signer>, signers: readonly Signer[], limits: DriveLimits = DOOR_LIMITS,
): Promise<{ paidIn: string | null; final: ChainFacts }> {
  const seen = async (what: string, took: (c: ChainFacts) => boolean): Promise<void> => {
    for (let i = 0; i < limits.polls; i += 1) {
      if (took(await act.readChain())) return;
      await act.wait(limits.pollMs);
    }
    throw new Error(
      `${what} was submitted and the chain has not shown it after ${limits.polls} reads. Nothing further `
      + 'was submitted. Run the door again with the same answers once the indexer has caught up: it reads '
      + 'the chain and continues, and it does not repeat a step the chain shows as done.');
  };

  let paidIn: string | null = null;
  for (let n = 0; n < limits.steps; n += 1) {
    const chain = await act.readChain();
    const step = nextStep(chain);
    act.say(`chain: proposal ${chain.proposalOpen ? 'open' : 'not open'}, ${chain.approvals} of ${chain.needed} `
      + `approvals, this payment ${chain.paid ? 'IS' : 'is not'} recorded, block time ${chain.blockSeconds}. Next: ${step}.`);
    switch (step) {
      case 'paid':
        return { paidIn, final: chain };
      case 'window-closed':
        throw new Error(
          'the window of the recorded run has closed, so no payment can be made under it, and nothing was '
          + 'paid by this step. Move the payment record aside and run the door again to raise a new run.');
      case 'propose': {
        await act.holdsTheMoney();
        act.say(`proposed: ${await act.propose()}`);
        await seen('the proposal', (c) => c.proposalOpen || c.paid);
        break;
      }
      case 'approve': {
        const who = nextApprover(chain.approvals, signers);
        act.say(`approved as signer ${who}: ${await act.approve(who)}`);
        await seen(`signer ${who}'s approval`, (c) => c.approvals > chain.approvals || c.paid);
        break;
      }
      case 'window-not-open':
        await act.wait(limits.notOpenYetMs);
        break;
      case 'pay': {
        await act.stillHoldsTheMoney();
        paidIn = await act.pay();
        act.say(`paid: ${paidIn}`);
        await seen('the payment', (c) => c.paid);
        break;
      }
    }
  }
  throw new Error(
    `the account had not recorded this payment after ${limits.steps} steps. Run the door again with the same `
    + 'answers; it continues from what the chain says.');
}

/**
 * **WHAT A PERSON IS TOLD WHEN THE VAULT IS ASKED AGAIN, JUST BEFORE PAYING, AND
 * SAYS NO.** Could not read and does not hold are opposite facts with opposite
 * remedies: the first is asked again, and the second is a deposit. Saying the
 * vault is short when the chain merely did not answer is how a funded vault is
 * funded twice.
 */
export function refusalBeforePayment(e: unknown): unknown {
  if (!(e instanceof VaultCannotAfford)) return e;
  if (e.why === 'chain-unreadable') {
    return new Error(
      'the proposal is approved and the vault\'s balance could not be read just now, so nothing was paid. '
      + 'This is not the vault holding too little: do not deposit again. Run the door again with the same '
      + `answers and it asks again. ${e.message}`);
  }
  return new Error(`the proposal is approved and the chain says the vault no longer holds this payment. Nothing was paid. ${e.message}`);
}

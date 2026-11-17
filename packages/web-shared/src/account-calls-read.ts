/**
 * **THE CALLS TO THE COMPANY ACCOUNT, READ FROM ITS TRANSACTIONS**: which circuit each call ran and which
 * proposals it raised or closed, the runs a vouching call named, and the runs a removal has outrun.
 */
import type { Hex } from '../../../src/core/crypto.js';
import { vouchedFreshOf, vouchedRefusal } from '../../../src/midnight/record-tree.js';
import { SIGNER_LEAVES_FIELD } from 'midnight-identity/profile/account-state';
import { NO_LEG } from '../../../src/midnight/spending-policy-record.js';
import { bytesOf, hexOf } from './governance-payload.js';
import type { GovernedCallDeps } from './governed-call-builder.js';
import { OPEN_PROPOSALS_FIELD } from './account-anchors-read.js';

/**
 * One call to the account, as its transaction carries it: the circuit called,
 * the proposals, as 64 hex digits, it raised (`opened`: found not open by
 * its own check, then written into the account's open proposals) and took out
 * of them (`closed`), and the leaves it put into the account's signers
 * (`seated`). A call that writes over a proposal already open, as charging a
 * run to its period writes its cleared mark, raises nothing.
 */
export interface CallOnTheAccount {
  readonly entryPoint: string;
  readonly opened: ReadonlySet<string>;
  readonly closed: ReadonlySet<string>;
  readonly seated: ReadonlySet<string>;
}

type AlignedHere = { readonly value?: unknown };
/* The bytes of an aligned value of one atom, or null for any other shape. The ledger drops an atom's trailing zero bytes. */
const atomOf = (v: AlignedHere | undefined): Uint8Array | null => {
  const parts = v?.value;
  return Array.isArray(parts) && parts.length === 1 && parts[0] instanceof Uint8Array ? parts[0] : null;
};
/* Whether `op` indexes one field of the account's public state: to write it (`pushPath`), or to read it. */
const isFieldOfTheAccount = (op: unknown, writing: boolean, at: number): boolean => {
  const idx = (op as { idx?: { pushPath?: unknown; path?: unknown } } | null)?.idx;
  if (idx === undefined || idx.pushPath !== writing || !Array.isArray(idx.path) || idx.path.length !== 1) return false;
  const key = idx.path[0] as { tag?: unknown; value?: AlignedHere };
  const field = key.tag === 'value' ? atomOf(key.value) : null;
  return field !== null && field.length <= 1 && (field[0] ?? 0) === at;
};
const isOpenProposalsField = (op: unknown, writing: boolean): boolean => isFieldOfTheAccount(op, writing, OPEN_PROPOSALS_FIELD);
const proposalKeyOf = (op: unknown): string | null => {
  const push = (op as { push?: { storage?: unknown; value?: { tag?: unknown; content?: AlignedHere } } } | null)?.push;
  if (push === undefined || push.storage !== false || push.value?.tag !== 'cell') return null;
  const bytes = atomOf(push.value.content);
  if (bytes === null || bytes.length > 32) return null;
  const whole = new Uint8Array(32);
  whole.set(bytes);
  return hexOf(whole);
};
const opIs = (op: unknown, name: string): boolean => typeof op === 'object' && op !== null && name in op;
/* The answer a call's `member` check took from the chain, as the transaction carries it: true, false, or null when not one. */
const memberAnswerOf = (op: unknown): boolean | null => {
  const popeq = (op as { popeq?: { result?: AlignedHere } } | null)?.popeq;
  const bytes = popeq === undefined ? null : atomOf(popeq.result);
  return bytes === null || bytes.length > 1 ? null : (bytes[0] ?? 0) === 1;
};

/**
 * **THE CALLS TO THE ACCOUNT IN ONE TRANSACTION, READ FROM ITS BYTES** as the
 * chain holds them (signed, proved, bound), in the order its segments run.
 * Each call's operations, guaranteed and fallible, are what the chain ran on the
 * account's state, so a proposal's identity is read where a call indexes the
 * account's open proposals and then pushes that identity: removed (`rem`)
 * closes it; a value pushed and inserted (`ins`) raises it only where the same
 * call first checked that identity's membership and the chain answered that it
 * was not open (`member`, then the answer carried by `popeq`), as `propose`
 * does. A leaf is read where a call writes the account's signer leaves, pushes
 * that leaf and its value, and inserts it, as `seatInvited` does. Calls to any
 * other contract, and deploys, are left out. Refused when
 * the bytes are not such a transaction or its parts cannot be read.
 */
export function callsOnTheAccountIn(
  deps: Partial<Pick<GovernedCallDeps, 'ledger'>>, raw: Uint8Array, account: string,
): CallOnTheAccount[] {
  const here = String(account).toLowerCase().replace(/^0x/u, '');
  if (deps.ledger === undefined) throw new Error('this device was not given the ledger, so which call raised or closed a proposal was not read. Reload the page');
  let tx: { intents?: unknown };
  try {
    tx = deps.ledger.Transaction.deserialize('signature', 'proof', 'binding', raw);
  } catch (cause) {
    throw new Error('a transaction in the account\'s history could not be read, so which call raised or closed a proposal is not known. Read again', { cause });
  }
  if (!(tx.intents instanceof Map)) throw new Error('a transaction in the account\'s history holds no parts this device can read. Read again');
  const out: CallOnTheAccount[] = [];
  for (const [, intent] of [...tx.intents].sort(([a], [b]) => Number(a) - Number(b))) {
    const actions = (intent as { actions?: unknown } | null)?.actions;
    if (!Array.isArray(actions)) throw new Error('a transaction in the account\'s history holds a part whose calls this device cannot read. Read again');
    for (const a of actions as Array<Record<string, unknown>>) {
      if (!('entryPoint' in a) || String(a['address'] ?? '').toLowerCase() !== here) continue;
      const entry = a['entryPoint'];
      const entryPoint = entry instanceof Uint8Array ? new TextDecoder().decode(entry) : String(entry);
      const opened = new Set<string>();
      const closed = new Set<string>();
      const seated = new Set<string>();
      /* The identities this call found not open, by its own membership check; the guaranteed part runs before the fallible. */
      const notOpen = new Set<string>();
      for (const part of [a['guaranteedTranscript'], a['fallibleTranscript']]) {
        const program = (part as { program?: unknown } | undefined)?.program;
        if (part === undefined) continue;
        if (!Array.isArray(program)) throw new Error('a call in the account\'s history carries operations this device cannot read. Read again');
        program.forEach((op, i) => {
          if (isFieldOfTheAccount(op, true, SIGNER_LEAVES_FIELD)) {
            const leaf = proposalKeyOf(program[i + 1]);
            if (leaf !== null && opIs(program[i + 2], 'push') && opIs(program[i + 3], 'ins')) seated.add(leaf);
            return;
          }
          const reading = isOpenProposalsField(op, false);
          if (!reading && !isOpenProposalsField(op, true)) return;
          const id = proposalKeyOf(program[i + 1]);
          if (id === null) return;
          if (reading) {
            if (program[i + 2] === 'member' && memberAnswerOf(program[i + 3]) === false) notOpen.add(id);
          } else if (opIs(program[i + 2], 'rem')) closed.add(id);
          else if (opIs(program[i + 2], 'push') && opIs(program[i + 3], 'ins') && notOpen.has(id)) opened.add(id);
        });
      }
      out.push({ entryPoint, opened, closed, seated });
    }
  }
  return out;
}

/**
 * **WHERE ONE PROPOSAL STANDS ON THE CHAIN**, as the account's history at the
 * indexer the person's own wallet names shows it:
 *
 *   - `held`: `open` while the account's latest state holds it among its open
 *     proposals, `cleared` once that entry is the mark `clearRun` writes, `closed`
 *     once a state held it and the latest no longer does, `never` when no state
 *     the history shows held it - withdrawn before it reached the chain, refused
 *     by the service, sent and not yet seen, or opened and closed within one
 *     block, which no block's state shows: the chain cannot tell them apart.
 *     An identity held again after it closed is read from its latest time held;
 *   - `approvals`: the account's count of approvals for it now; once closed,
 *     its count in the last state that held it, so an approval given in the
 *     very block that closed it is not counted - shown, never a count it is
 *     approved or carried out at, which it no longer can be; 0 when never held;
 *   - `raisedAt`: the time, in milliseconds, the author of the first block of
 *     that time whose state held it set for that block;
 *   - `txRef`: the transaction of the call, in that block and in a
 *     transaction that succeeded in full, that raised it - found it not open
 *     and wrote it into the account's open proposals (`callsOnTheAccountIn`),
 *     never a call writing over it once open - read from the call's own
 *     operations in its transaction's bytes, so two raised in one block each
 *     name their own;
 *     the first such call where one block holds more. A step whose bytes the
 *     history does not carry is read as before: the one call to `propose` of
 *     the block's unread calls, absent where they hold more than one, since
 *     every step of a block carries the state after the whole block;
 *   - `closedBy`: the circuit of the call, in a transaction that succeeded in
 *     full in the first block whose state no longer held it, that took it out
 *     of the account's open proposals, read the same way - never another
 *     proposal's call of that block. Where no read call of that block took it
 *     out, the circuits of every unread call of that block; a failed call
 *     closes nothing, so none is named. Where every call of that block was read
 *     and none took it out, the read is refused, never answered with no call;
 *   - `failedCalls`: while it is held, the circuits called by every call whose
 *     transaction landed without succeeding in full in a block since it was
 *     raised - a call in its transaction's fallible section that the account
 *     refused, its fee paid and nothing of it written. A state names no
 *     proposal a call was for, so a failed call is any proposal's of those
 *     blocks;
 *   - `needed`: the approvals the account recorded it as needing when it was
 *     raised (its hold) - for a change to the company, the account's threshold
 *     then - read from the latest state while held and from the last state
 *     that held it once closed. Absent where that state holds no hold for it;
 *   - `opensAt`: while it is held, for a run, the time in seconds its window
 *     opens, as the account holds it (`runWindow`); absent for a governance
 *     proposal, which has no window;
 *   - `approvedHere`: asked with a seat, whether the account's latest state
 *     holds that seat's approval marker for it (`approvalNullifierOf`), so the
 *     seat has approved it or raised it counted. Absent when no seat was given;
 *   - `raisedHere`: asked with a seat, while it is held, whether its hold in the
 *     latest state carries the withdraw key that seat makes for it
 *     (`withdrawKeyOf(withdrawSecretOf(...))`), the key its raise wrote: so that
 *     seat raised it, and only that seat may withdraw a change to the company.
 *     Absent when no seat was given, once it is no longer held, where the
 *     state holds no withdraw key for it, and where this device was not given
 *     the account's withdraw derivation.
 */
export interface RoundOnChain {
  readonly held: 'open' | 'cleared' | 'closed' | 'never';
  readonly approvals: number;
  readonly raisedAt?: number;
  readonly txRef?: string;
  readonly closedBy?: readonly string[];
  readonly failedCalls?: readonly string[];
  /** The approvals its hold says it needed when it was raised; the account carries it out only at least at this many. */
  readonly needed?: number;
  /** A run's: the time, in seconds, from which the account lets it be paid; before it, any signer may still withdraw it. */
  readonly opensAt?: number;
  /**
   * Open, and a signer was removed or replaced since it was raised: the account's count of removals is no longer the
   * one its hold took at the raise. A change to the company is then never carried out (`requireApproved`) and is raised
   * again; a run still is, at one more approval for each removal (`removals`).
   */
  readonly outrun?: true;
  /**
   * How many signers were removed or replaced since it was raised, when any were: a run is charged or paid only at its
   * hold's `needed` (or its vault's bar now, if higher) plus this many (`requireApprovedForVault`).
   */
  readonly removals?: number;
  /** Asked with a seat: the account's latest state holds that seat's approval marker for it. The account then refuses the seat's approve. */
  readonly approvedHere?: boolean;
  /** Asked with a seat, while held: its hold carries the withdraw key that seat makes, so that seat raised it. */
  readonly raisedHere?: boolean;
}

/**
 * Every circuit of the account that closes a proposal (`closeProposal`, ConfidentialAccount.compact), named so a
 * block that holds any of them beside a seating is never read as that seating's. Checked against the contract's
 * source by every-circuit-that-closes-a-proposal-is-known.test.ts.
 */
export const PROPOSAL_CLOSING_CIRCUITS: readonly string[] = Object.freeze([
  'adopt', 'approveVaultChange', 'cancel', 'closeExpiredRun', 'recoverAnchor', 'removeSignerAndSetThreshold',
  'reseatSigner', 'retireVault', 'sealPayKey', 'seatInvited', 'setPolicy', 'setPolicyBar', 'setThreshold', 'setVaultThreshold',
]);

export interface VouchedRunOnTheWire {
  readonly root: string; readonly payees: string; readonly opensAt: string; readonly closesAt: string; readonly required: string;
  readonly vault: string; readonly head: string; readonly r: string;
}

/**
 * **THE IDENTITY ON CHAIN A LEG'S RUN WOULD HAVE, RAISED OVER THE HEAD IT
 * SEALS**, by the account's own functions: `proposalIdOf(runPayload(..), vault,
 * retrySaltOf(no leg, vouchedFreshOf(head, r)))`. A device that finds it is the
 * run's own identity knows the run's approvers approved that head. Null for a
 * run of no vault, which vouches for nothing.
 */
export function vouchedRunIdentityOf(deps: Pick<GovernedCallDeps, 'accountPure'>, run: VouchedRunOnTheWire): string | null {
  const P = deps.accountPure;
  if (P.retrySaltOf === undefined) throw new Error('this device was not given the account\'s functions a run\'s salt is made with. Reload the page');
  const whole = (what: string, v: string): bigint => {
    if (!/^(0|[1-9][0-9]*)$/u.test(String(v))) throw new Error(`a vouching run's ${what} is not a whole number`);
    return BigInt(v);
  };
  if (vouchedRefusal({ head: run.head, r: run.r }) !== null) return null;
  const vault = bytesOf('vault', String(run.vault).toLowerCase());
  if (hexOf(vault) === hexOf(P.noVault())) return null;
  const payload = P.runPayload(bytesOf('run root', String(run.root).toLowerCase()), whole('payee count', run.payees),
    whole('window', run.opensAt), whole('window', run.closesAt), whole('approvals', run.required));
  const salt = P.retrySaltOf(NO_LEG(), bytesOf('fresh', vouchedFreshOf(run.head.toLowerCase() as Hex, run.r.toLowerCase() as Hex)));
  return hexOf(P.proposalIdOf(payload, vault, salt));
}

/** A payroll run that vouches for the head its raiser sealed: its identity on chain, and the block of the last state showing it paid or charged. */
export interface VouchingRun { readonly chainId: string; readonly height: number; readonly at: number }

/**
 * **EVERY RUN WHOSE APPROVALS VOUCH FOR WHAT IT WAS RAISED OVER, FROM THE
 * ACCOUNT'S HISTORY**: each proposal a state holds charged to its period (the
 * mark `clearRun` writes) or paid from (the mark `markPaidFrom` writes on its
 * hold), read at the last state that shows it so, and kept only when that
 * state counts the approvals the account's `runApprovalsNeeded` gives for it,
 * with the account's threshold standing as the vault's bar: the higher of its
 * bar when raised and that threshold, plus one for every signer removed since it
 * was raised. A run approved only to a vault's lower threshold does not reach it. Only payroll
 * runs carry either mark. A run whose hold was released before it was paid
 * keeps the released mark, not the paid one, and vouches nothing unless the
 * account charged it. Oldest first.
 */
export function vouchingRunsIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>,
  steps: ReadonlyArray<{ readonly state: Uint8Array; readonly block: { readonly height: number; readonly at: number } }>,
): VouchingRun[] {
  const P = deps.accountPure;
  if (deps.accountLedger === undefined || P.clearedMark === undefined || P.paidFromMark === undefined || P.removalCountKey === undefined
    || P.runApprovalsNeeded === undefined) {
    throw new Error('this device was not given the account\'s reader, so which runs vouch for the company\'s records was not read. Reload the page');
  }
  const cleared = hexOf(P.clearedMark());
  const paidFrom = hexOf(P.paidFromMark());
  const removalKey = P.removalCountKey();
  const neededFor = P.runApprovalsNeeded;
  type Hold = { readonly needed: bigint; readonly removals: bigint; readonly runHold: { readonly placedBy: Uint8Array } };
  type View = {
    readonly threshold: bigint;
    readonly openProposals: Iterable<[Uint8Array, Uint8Array]>;
    readonly approvalCounts: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): bigint };
    readonly proposalHolds: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): Hold };
  };
  /* The last state showing each run marked, and whether it counted enough approvals then. */
  const last = new Map<string, { readonly vouches: boolean; readonly height: number; readonly at: number }>();
  let height = Number.NaN;
  for (const step of steps) {
    /* One state per block: every step of a block shows the state after the whole block. */
    if (step.block.height === height) continue;
    height = step.block.height;
    const view = deps.accountLedger((deps.runtimeState.deserialize(step.state) as { data: unknown }).data) as View;
    const removals = view.proposalHolds.member(removalKey) ? BigInt(view.proposalHolds.lookup(removalKey).removals) : 0n;
    for (const [id, change] of view.openProposals) {
      const hold = view.proposalHolds.member(id) ? view.proposalHolds.lookup(id) : null;
      const marked = hexOf(change) === cleared || (hold !== null && hexOf(hold.runHold.placedBy) === paidFrom);
      if (!marked) continue;
      const approvals = view.approvalCounts.member(id) ? BigInt(view.approvalCounts.lookup(id)) : 0n;
      const vouches = hold !== null
        && approvals >= BigInt(neededFor(BigInt(hold.needed), BigInt(view.threshold), removals, BigInt(hold.removals)));
      last.set(hexOf(id), { vouches, height: step.block.height, at: step.block.at });
    }
  }
  return [...last].filter(([, l]) => l.vouches).map(([chainId, l]) => ({ chainId, height: l.height, at: l.at }))
    .sort((a, b) => a.height - b.height);
}

/**
 * **EVERY RUN OPEN NOW**, by its identity on the chain, with the signers removed or replaced since it was raised (0 for
 * one no removal has outrun): each needs one approval more for each (`runApprovalsNeeded`), and one more for the next. Read from the newest state of the
 * account's history at the indexer the person's own wallet names, never from a list the service or the records give,
 * so a run nobody listed is still counted. A run is an open proposal the account keeps a window for (`runWindow`).
 * Which vault it pays from is sealed in its record and is not read here.
 */
export function runsOutrunIn(
  deps: Pick<GovernedCallDeps, 'accountPure' | 'accountLedger' | 'runtimeState'>,
  steps: ReadonlyArray<{ readonly state: Uint8Array }>,
): Record<string, number> {
  const removalKey = deps.accountPure.removalCountKey?.();
  if (deps.accountLedger === undefined || removalKey === undefined) {
    throw new Error('this device was not given the account\'s reader, so the runs open on the chain were not read. Reload the page');
  }
  const newest = steps[steps.length - 1];
  if (newest === undefined) return {};
  type View = {
    readonly openProposals: Iterable<[Uint8Array, Uint8Array]>;
    readonly runWindow: { member(id: Uint8Array): boolean };
    readonly proposalHolds: { member(id: Uint8Array): boolean; lookup(id: Uint8Array): { readonly removals: bigint } };
  };
  const view = deps.accountLedger((deps.runtimeState.deserialize(newest.state) as { data: unknown }).data) as View;
  const now = view.proposalHolds.member(removalKey) ? BigInt(view.proposalHolds.lookup(removalKey).removals) : 0n;
  const out: Record<string, number> = {};
  for (const [id] of view.openProposals) {
    if (!view.runWindow.member(id) || !view.proposalHolds.member(id)) continue;
    const since = now - BigInt(view.proposalHolds.lookup(id).removals);
    if (since >= 0n && since <= BigInt(Number.MAX_SAFE_INTEGER)) out[hexOf(id)] = Number(since);
  }
  return out;
}

/**
 * **ONE APPROVAL, FOR EVERY KIND OF PROPOSAL, IN THE WALLET.** A proposal another signer raised is approved here in one
 * step: the proposal named is opened from the company's own records and checked as its kind requires, where it stands
 * is read from the chain through this wallet's own indexer, this seat's approval is built and sent only when it is still
 * owed and the proposal is short of the approvals the account needs, and what the page is told (where it got to, its
 * approvals and the approvals it needs) is read from the chain again after the send, never from the service.
 *
 * Each kind brings only what is its own (`ProposalKind`): the lines the window shows, the checks of what it opens, the
 * approvals the account needs for it, and what carries it out once those are given. A change the wallet carries out
 * itself is carried out by the one carry step (`carryStep`), which reads the chain again first. Whether this seat's approval is
 * already counted (a raise counts the seat that proved it) is read from the chain, by this seat's own approval marker
 * (`approvedHere`), never from a refused build. A recovery of the company's records is the one kind that brings its own
 * lines and steps instead (`ChainOnlyKind`): it runs on the chain and the person's own wallet alone.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import type { AccountGovernance } from 'midnight-identity/profile/records-key';
import type { RoundOnChain } from '../../../../packages/web-shared/src/governed-call-builder.js';
import { ApprovalNotOwed, nothingWasSentBy, WithdrawnWhileSent } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { addSignerKind, type AddSignerReach } from './add-signer-kind.js';
import { thresholdKind } from './change-threshold.js';
import { removalKind, type RemoveSignerReach } from './remove-signer.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import type { CompanyChain, CompanyReach, Handed } from './company-reach.js';
import { codeOfError, StepRefused, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { oneOffKind, type OneOffPaymentReach } from './one-off-payment.js';
import { payrollKind } from './raise-run.js';
import { ActionStopped } from './run.js';
import type { upkeepSteps } from './upkeep.js';
import { recoveryKind, type RecoveryReach } from './recovery.js';
import { policyBarKind, spendingPolicyKind } from './policy-kinds.js';
import { adoptVaultKind, vaultSecretKind, type StartKindsReach } from './start-kinds.js';
import { payKeyKind } from './pay-key-kind.js';
import { retireVaultKind, type RetireVaultReach } from './retire-vault.js';

/**
 * A proposal as this wallet opened it from the company's records: its id and its identity on the chain, and, for an
 * intent its kind reads first (`readsFirst`), what it read and the lines the window shows of it.
 */
export interface OpenedRound {
  readonly id: string;
  readonly chainId: string;
  /** What the seat approves, read once with its keys: handed to the approval and the carrying out exactly as it was shown. */
  readonly read?: unknown;
  /** The lines the window shows of what was read, for the person to confirm before anything is sent. */
  readonly confirm?: readonly Words[];
}

/** The proposal the approval and the carrying out act on: its id, its identity on the chain, and what was read of it. */
export type RoundHere = { readonly id: string; readonly chainId: string; readonly read?: unknown };

/**
 * What every step of one approval shares: the proposal approved, as it was opened in the first step when its kind reads
 * first, where the chain last showed it, and the bar it needs.
 */
export interface Approving {
  round: RoundHere | null;
  opened: OpenedRound | null;
  standing: RoundOnChain | null;
  needed: number | null;
  short: boolean;
  paid: boolean;
}

export const approving = (): Approving => ({ round: null, opened: null, standing: null, needed: null, short: false, paid: false });

/** The company as the steps read it, once per action (`keptReach`). */
export interface ReadCompany {
  readonly at: (ctx: StepContext) => Promise<CompanyReach>;
  readonly renew: () => void;
}

/** Why an approval stopped, in words every kind says its own way. */
export type ApprovalStop = 'not-approved' | 'may-be-sent' | 'withdrawn' | 'closed' | 'counted' | 'not-raised' | 'outrun' | 'not-carried';

/** What one kind of proposal brings to the one approval. */
export interface ProposalKind {
  /** The intent's fields this kind needs, besides the company and the proposal. */
  readonly fields: readonly string[];
  /** Whether it changes the company, so a removal since its raise means the account never carries it out (`requireApproved`). */
  readonly changesTheCompany: boolean;
  /**
   * Set when what the approval is about opens only with the seat's keys (a spending policy's terms, whose seat a removal
   * takes), or must be compared by the person with what somebody tells them (the fingerprint of a seat named by its
   * leaf), for every intent or for the intents it answers true for: the proposal is opened in the first step, before
   * anything is sent, and the person confirms what was read in the window before the action goes on (`confirmFirst`).
   */
  readonly readsFirst?: true | ((intent: ActIntent) => boolean);
  /** The lines the window shows for it, before the upkeep's. */
  shown(intent: ActIntent): Promise<readonly ShownLine[]>;
  /** A check of the intent's own fields, before anything is read: the words of the refusal, or null. */
  check(intent: ActIntent): Words | null;
  /**
   * Opens the proposal named from the company's records and checks it as this kind requires, before anything is built:
   * its id and its identity on the chain, as a record this device checked names it, never as the service lists it; for a
   * kind that reads first, also what it read and the lines to confirm. It reads and sends nothing else.
   */
  opened(ctx: StepContext, r: CompanyReach, intent: ActIntent): Promise<OpenedRound>;
  /** The approvals the account needs to carry it out, from where the chain shows it and the account as the chain holds it; null when not known. */
  needed(round: RoundOnChain, held: AccountGovernance, intent: ActIntent): number | null;
  /** Its own checks against the chain, then this seat's approval. `handed.over` is set once anything is handed over to be sent. */
  approve(ctx: StepContext, r: CompanyReach, intent: ActIntent, round: RoundHere, handed: Handed): Promise<void>;
  /** What the page is told it is at: once at its bar, or short of it. */
  stateAt(atItsBar: boolean, approvedNow: boolean, outrun: boolean): string | null;
  /** The steps that carry it out once approved, sharing `here`; absent when another carries it out (the invitee, for a seat). */
  carry?(here: Approving, read: ReadCompany, intent: ActIntent): readonly ActionStep[];
  /**
   * What is still owed of it once the chain has closed it other than by a withdrawal, done here: the state the page is
   * told, or null when nothing is owed and the proposal is refused as closed. Absent, a closed proposal is refused.
   */
  afterClosed?(ctx: StepContext, r: CompanyReach, intent: ActIntent, round: RoundHere): Promise<string | null>;
  /** What the upkeep keeps beside the company for it (the coins a payment keeps in flight), when anything. */
  readonly upkeep?: Parameters<typeof upkeepSteps>[1];
  /** The words of each stop. */
  why(stop: ApprovalStop, values?: Readonly<Record<string, string | number>>): Words;
}

/** What an error says, as the words of a refusal carry it. */
export const said = (e: unknown): string => String((e as Error)?.message ?? e);

/** Where the proposal stands, read from the chain through this wallet's own indexer. */
export const onTheChain = async (r: CompanyReach, chainId: string): Promise<RoundOnChain | undefined> =>
  (await r.builder.roundsOnChain({ account: r.account, indexer: r.chain.indexer, chainIds: [chainId] }))[chainId.toLowerCase()];

/** At its bar: open (or cleared, for a run charged to its period) and given at least the approvals the account needs. */
export const atTheBar = (round: RoundOnChain | null, needed: number | null): boolean =>
  round !== null && (round.held === 'open' || round.held === 'cleared') && needed !== null && round.approvals >= needed;

/** Whether `kind` reads `intent`'s proposal first, for the person to confirm (`readsFirst`). */
export const readsFirstFor = (kind: ProposalKind, intent: ActIntent): boolean =>
  kind.readsFirst === true || (typeof kind.readsFirst === 'function' && kind.readsFirst(intent));

/**
 * **WHAT THE PERSON CONFIRMS BEFORE ANYTHING IS SENT**, for a kind that reads first: opens the proposal with the seat's
 * keys, keeps what was read in `here` for the approval and the carrying out, and waits on the person's Confirm of the
 * lines it shows. Run in the first step, before any step hands anything over; nothing is read again before it is signed.
 * Does nothing for a kind that does not read first. Stops the action when the kind gives nothing to show.
 */
export async function confirmFirst(kind: ProposalKind, intent: ActIntent, r: CompanyReach, here: Approving, ctx: StepContext): Promise<void> {
  if (!readsFirstFor(kind, intent)) return;
  const named = await kind.opened(ctx, r, intent);
  if (named.confirm === undefined || named.confirm.length === 0) throw new ActionStopped('step-failed');
  here.opened = named;
  await ctx.confirm(named.confirm);
}

/**
 * **THE ONE APPROVE STEP.** Refuses, before anything is built, a proposal the chain never held or has closed (unless its
 * kind still owes something once it is closed, `afterClosed`, which is then done instead), and a change to the company a removal since its raise has outrun. Builds nothing when the proposal already has the approvals it
 * needs. Otherwise the kind checks and approves; an approval the account says it already counts is not owed. The count
 * and the bar are read from the chain after. A kind that reads first approves the proposal as the first step opened it
 * and the person confirmed it, never opened again.
 */
export function approveStep(kind: ProposalKind, intent: ActIntent, read: ReadCompany, here: Approving, title: Words): ActionStep {
  return {
    title,
    run: async (ctx) => {
      const r = await read.at(ctx);
      const named = here.opened ?? await kind.opened(ctx, r, intent);
      here.round = { id: named.id, chainId: named.chainId.toLowerCase(), ...(named.read === undefined ? {} : { read: named.read }) };
      const before = await onTheChain(r, here.round.chainId);
      if (before === undefined || before.held === 'never') throw new StepRefused(kind.why('not-raised'));
      if (before.held === 'closed') {
        const cancelled = (before.closedBy ?? []).includes('cancel');
        const owed = cancelled || kind.afterClosed === undefined ? null : await kind.afterClosed(ctx, r, intent, here.round);
        if (owed === null) throw new StepRefused(kind.why(cancelled ? 'withdrawn' : 'closed'));
        /* Finished here: no carry step runs after it. */
        here.round = null;
        ctx.tell({ state: owed, approvals: before.approvals, ...(before.needed === undefined ? {} : { needed: before.needed }) });
        return;
      }
      if (kind.changesTheCompany && before.outrun === true) throw new StepRefused(kind.why('outrun'));
      const held = await r.holders();
      let counted = false;
      let approvedNow = false;
      if (!counted && !atTheBar(before, kind.needed(before, held, intent))) {
        const handed: Handed = { over: false };
        try {
          await kind.approve(ctx, r, intent, here.round, handed);
          approvedNow = true;
        } catch (e) {
          if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
          const code = codeOfError(e);
          if (e instanceof ApprovalNotOwed && e.why === 'carried-out') throw new StepRefused(kind.why('closed'), code);
          if (e instanceof WithdrawnWhileSent) throw new StepRefused(kind.why('withdrawn'), code);
          if (e instanceof ApprovalNotOwed) counted = true;
          else throw new StepRefused(kind.why(!handed.over || nothingWasSentBy(e) ? 'not-approved' : 'may-be-sent', { says: said(e) }), code);
        }
      }
      if (counted && kind.carry === undefined) throw new StepRefused(kind.why('counted'), 'approval-not-owed');
      const after = approvedNow ? (await onTheChain(r, here.round.chainId)) ?? before : before;
      here.standing = after;
      here.needed = kind.needed(after, await r.holders(), intent);
      const state = kind.stateAt(atTheBar(after, here.needed), approvedNow, after.outrun === true);
      ctx.tell({ ...(state === null ? {} : { state }), approvals: after.approvals, ...(here.needed === null ? {} : { needed: here.needed }) });
    },
  };
}

/**
 * Carries out one change at its bar. `handed.over` is set once anything is handed over to be sent. It answers nothing
 * when the change is carried out, or the state the page is told instead where carrying it out waits on something more
 * than the approvals (a removal whose retirement is not yet signed by enough seats).
 */
export type CarryOut = (
  ctx: StepContext, r: CompanyReach, intent: ActIntent, round: RoundHere, handed: Handed,
  /** The company read again from the chain and its records, for what runs after a carrying out that changed it. */
  renewed: () => Promise<CompanyReach>,
) => Promise<void | { readonly state: string }>;

/** What the page is told the carry step got to. */
export const CARRY_STATE = { waiting: 'waiting-for-approvals', carried: 'carried-out' } as const;

/**
 * **THE ONE CARRY STEP.** Carries out the change `here` names once the chain counts the approvals its kind needs, read
 * again from the chain through this wallet's own indexer, never from the service. A change the chain never held or has
 * closed, or one a removal since its raise has outrun, is refused before anything is built; one still short of its bar
 * is left for the others to approve, and nothing is sent. The page is told the approvals and the bar the chain showed,
 * and that the change was carried out, or the state its kind answered instead.
 */
export function carryStep(kind: ProposalKind, intent: ActIntent, read: ReadCompany, here: Approving, title: Words, carryOut: CarryOut): ActionStep {
  return {
    title,
    run: async (ctx) => {
      if (here.round === null) return;
      const r = await read.at(ctx);
      const round = here.round;
      const now = await onTheChain(r, round.chainId);
      if (now === undefined || now.held === 'never') throw new StepRefused(kind.why('not-raised'));
      if (now.held === 'closed') throw new StepRefused(kind.why((now.closedBy ?? []).includes('cancel') ? 'withdrawn' : 'closed'));
      if (kind.changesTheCompany && now.outrun === true) throw new StepRefused(kind.why('outrun'));
      const needed = kind.needed(now, await r.holders(), intent);
      here.standing = now;
      here.needed = needed;
      const told = { approvals: now.approvals, ...(needed === null ? {} : { needed }) };
      if (!atTheBar(now, needed)) {
        ctx.tell({ state: CARRY_STATE.waiting, ...told });
        return;
      }
      const handed: Handed = { over: false };
      let carried: void | { readonly state: string };
      try {
        carried = await carryOut(ctx, r, intent, round, handed, async () => { read.renew(); return read.at(ctx); });
      } catch (e) {
        if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
        throw new StepRefused(kind.why(!handed.over || nothingWasSentBy(e) ? 'not-carried' : 'may-be-sent', { says: said(e) }), codeOfError(e));
      }
      ctx.tell({ state: carried?.state ?? CARRY_STATE.carried, ...told });
    },
  };
}

/** Everything the kinds read: the company's chain and builder, the wallet's clock and pause, and each kind's own. */
export type ProposalKindsReach = AddSignerReach & OneOffPaymentReach & Pick<RemoveSignerReach, 'afterCarried'> & {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  /** The chain, the heads this device kept and the person's own wallet, for a recovery; absent, a recovery is refused. */
  readonly recovery?: RecoveryReach;
} & Pick<StartKindsReach, 'indexerHttp'> & Pick<RetireVaultReach, 'inFlight'>;

/**
 * **A KIND APPROVED ON THE CHAIN AND THE PERSON'S OWN WALLET ALONE**: its own
 * lines and its own steps, which ask nothing of the company's service and keep
 * none of the company's records, in place of the steps every other kind shares.
 */
export interface ChainOnlyKind {
  readonly chainOnly: true;
  readonly fields: readonly string[];
  /** What it checks after the passkey, as the window lists it: its own, never the shared steps'. */
  readonly checks: readonly Words[];
  shown(intent: ActIntent): Promise<readonly ShownLine[]>;
  check(intent: ActIntent): Words | null;
  steps(intent: ActIntent): readonly ActionStep[];
}

/** True of a kind that runs on the chain and the person's own wallet alone. */
export const isChainOnly = (kind: ProposalKind | ChainOnlyKind): kind is ChainOnlyKind => 'chainOnly' in kind && kind.chainOnly === true;

/** **THE KINDS THE ONE APPROVAL KNOWS**, by the name the page gives in the intent's `kind`. */
export const proposalKinds = (reach: ProposalKindsReach): Readonly<Record<string, ProposalKind | ChainOnlyKind>> => Object.freeze({
  'add-signer': addSignerKind(reach),
  'one-off': oneOffKind(reach),
  threshold: thresholdKind(reach, 'threshold'),
  'vault-threshold': thresholdKind(reach, 'vault-threshold'),
  removal: removalKind(reach),
  payroll: payrollKind(reach),
  recovery: recoveryKind(reach.recovery),
  'spending-policy': spendingPolicyKind(reach),
  'policy-bar': policyBarKind(reach),
  'adopt-vault': adoptVaultKind(reach),
  'vault-secret': vaultSecretKind(reach),
  'pay-key': payKeyKind(reach),
  'retire-vault': retireVaultKind(reach),
});

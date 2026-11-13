/**
 * **THE APPROVALS NEEDED, CHANGED IN THE WALLET**: the company's own threshold, or the approvals one vault's runs need,
 * raised from the seat this wallet holds through the account's `propose`, approved by the other signers through the one
 * approval (`proposalKinds`), and carried out by the one carry step once the chain counts its bar. At a bar of one the
 * raise is carried out in the same window.
 *
 * Every fact a check rests on is read from the chain through this wallet's own indexer (the seats, the threshold, each
 * vault's own, the bars, the vaults the account holds, and every open run a removal has outrun) or from the company's
 * records this wallet opens (who may approve each vault's runs), never from the service. A change the chain would refuse
 * when it is carried out, or one that would leave a vault unable to pay, is refused before anything is built, and again
 * before every send: the raise, an approval and the carrying out.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { readVaultAddress } from 'midnight-identity/profile/company-label';
import type { AccountGovernance } from 'midnight-identity/profile/records-key';
import type { Hex } from '../../../../src/core/crypto.js';
import { thresholdCarryBar, thresholdChangeRefusal, type ThresholdChange } from '../../../../src/core/vault-approvers.js';
import type { GovernanceOnTheWire } from '../../../../packages/web-shared/src/governed-call-builder.js';
import {
  ApprovalNotOwed, changeThresholdOnDevice, changeVaultThresholdOnDevice, nothingWasSentBy, withCompanyKeys, WithdrawnWhileSent,
  type GovernanceDoors, type GovernedOutcome, type ThresholdChangeSteps,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { openTheRoundHere } from '../../../../packages/web-shared/src/round-opened-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import {
  approversHere, companyReachFor, governanceDoorsFor, keptReach, runsOutrunHere,
  type CompanyChain, type CompanyReach, type Handed,
} from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { approving, carryStep, onTheChain, type ApprovalStop, type CarryOut, type ProposalKind } from './proposal-kinds.js';
import { ActionStopped } from './run.js';
import { anchorDirectoryDoorIn, UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/** What the wallet reads: the company's chain and builder, its pause, and how long it waits for the chain. */
export interface ChangeThresholdReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly waitMs?: number;
  readonly everyMs?: number;
  /** Stands in for reading the company and this seat, for the tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** What the page is told the raise got to. */
export const CHANGE_THRESHOLD_STATE = { waiting: 'waiting-for-approvals', atItsBar: 'ready-to-carry' } as const;

/** Refused here, before anything was sent: the chain would refuse the change, or it would leave a vault unable to pay. */
export class ThresholdRefused extends Error {
  readonly nothingWasSent = true;
  constructor(why: string) {
    super(`${why.charAt(0).toUpperCase()}${why.slice(1)} Nothing was sent.`);
    this.name = 'ThresholdRefused';
  }
}

type Which = 'threshold' | 'vault-threshold';
type Asked = { readonly kind: 'threshold'; readonly threshold: number } | { readonly kind: 'vault-threshold'; readonly vault: Hex; readonly threshold: number };

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.change-threshold.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const WHOLE = /^[1-9][0-9]{0,8}$/u;

/** The change the intent names, as the page showed it; `which` null takes a vault's when the intent names a vault. */
const askedOf = (intent: ActIntent, which: Which | null): Asked | Words => {
  const f = intent.fields;
  if (!WHOLE.test(f['threshold'] ?? '')) return why('not-a-threshold');
  const threshold = Number(f['threshold']);
  if ((which ?? (f['vault'] === undefined ? 'threshold' : 'vault-threshold')) === 'threshold') {
    return f['vault'] === undefined ? { kind: 'threshold', threshold } : why('not-a-threshold');
  }
  const vault = readVaultAddress(f['vault']);
  return vault === null ? why('not-a-threshold') : { kind: 'vault-threshold', vault: String(vault).toLowerCase() as Hex, threshold };
};

const countedOf = (a: Asked): ThresholdChange =>
  (a.kind === 'threshold' ? { kind: 'threshold', threshold: a.threshold } : { kind: 'vaultThreshold', vault: a.vault, threshold: a.threshold });

/** Whether a proposal opened from the company's records changes exactly what the page showed. */
const isAsked = (g: GovernanceOnTheWire | undefined, a: Asked): boolean => {
  if (g === undefined || g.kind !== a.kind || String((g as { threshold?: unknown }).threshold) !== String(a.threshold)) return false;
  return a.kind === 'threshold' || String((g as { vault?: unknown }).vault).toLowerCase() === a.vault;
};

/**
 * **EVERY CHECK OF A THRESHOLD CHANGE, AS THE CHAIN AND THE COMPANY'S RECORDS STAND NOW** (`thresholdChangeRefusal`):
 * the seats, the threshold, the bars and the vaults the account holds from this wallet's read of the chain, who may
 * approve each vault's runs from the roster this wallet opens, and the signers removed since the open run they outran
 * most was raised, read from the chain. Refuses by throwing `ThresholdRefused`.
 */
export const refuseAThresholdChangeHere = async (r: CompanyReach, a: Asked): Promise<void> => {
  const [roster, held, wide] = await Promise.all([approversHere(r, () => runsOutrunHere(r)), r.holders(), r.builder.companyWide()]);
  const no = thresholdChangeRefusal(roster, {
    seats: held.seats.length, approvals: held.approvals, policyBar: held.policyBar, adoptedVaults: held.adoptedVaults, companyWide: wide,
  }, countedOf(a));
  if (no !== null) throw new ThresholdRefused(no);
};

/** The change taken through the shared code as far as `steps` say, with every check before every send. */
const onDevice = async (doors: GovernanceDoors, r: CompanyReach, a: Asked, steps: ThresholdChangeSteps): Promise<GovernedOutcome> => {
  const seated = (await r.holders()).seats.length;
  const before = () => refuseAThresholdChangeHere(r, a);
  return a.kind === 'threshold'
    ? changeThresholdOnDevice(doors, withCompanyKeys({ newThreshold: a.threshold, seated, ...steps, before }, r.companyKeys))
    : changeVaultThresholdOnDevice(doors, withCompanyKeys({ vault: a.vault, newThreshold: a.threshold, seated, ...steps, before }, r.companyKeys));
};

/** The shared code's doors, with the directory anchored first by this wallet when a rise finds a change of it not yet anchored. */
const doorsOf = (r: CompanyReach, reach: Pick<ChangeThresholdReach, 'pause' | 'waitMs' | 'everyMs'>, ctx: StepContext, handed: Handed) => ({
  ...governanceDoorsFor(r, (ms) => reach.pause(ms, ctx.signal), handed, {
    ...(reach.waitMs === undefined ? {} : { waitMs: reach.waitMs }), ...(reach.everyMs === undefined ? {} : { everyMs: reach.everyMs }),
  }),
  anchorDirectory: anchorDirectoryDoorIn(r, handed),
});

/** A stop in the shared code, in the words of `notSent` when nothing was handed over to be sent. */
const stoppedAs = (e: unknown, handed: Handed, notSent: string, whyOf: (k: string, v?: Readonly<Record<string, string>>) => Words): never => {
  if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
  if (e instanceof ThresholdRefused) throw new StepRefused(whyOf('refused', { says: said(e) }), codeOfError(e));
  throw new StepRefused(whyOf(!handed.over || nothingWasSentBy(e) ? notSent : 'may-be-sent', { says: said(e) }), codeOfError(e));
};

/** Carries a threshold change out at its bar, approving nothing; refused when the chain shows it short. */
const carryOutFor = (reach: Pick<ChangeThresholdReach, 'pause' | 'waitMs' | 'everyMs'>, which: Which | null): CarryOut => async (ctx, r, intent, round, handed) => {
  const a = askedOf(intent, which);
  if ('key' in a) throw new StepRefused(a);
  const out = await onDevice(doorsOf(r, reach, ctx, handed), r, a, { approveOnly: round.chainId, carryOnly: true });
  if (out.state !== 'done') {
    throw Object.assign(new Error('the company\'s records do not show this proposal at the approvals it needs yet, so it was not carried out.'), { nothingWasSent: true });
  }
};

/**
 * What carrying the change out does beyond the number shown, said in the window whatever the chain holds now, since the
 * window is shown before anything is read: a vault raised past the approvals a change of who is seated needs raises those
 * too, and a number that is every signer leaves one lost key able to stop it.
 */
const consequencesOf = (intent: ActIntent, which: Which): ShownLine[] => {
  const values = { threshold: intent.fields['threshold'] ?? '' };
  return which === 'threshold'
    ? [{ key: 'act.change-threshold.shown.every-signer', values, from: 'action' }]
    : [{ key: 'act.change-threshold.shown.raises-the-seat-bar', values, from: 'action' }, { key: 'act.change-threshold.shown.every-signer-vault', values, from: 'action' }];
};

const KIND_WHY: Readonly<Record<string, string>> = { closed: 'carried-out', counted: 'already-counted' };

/**
 * **A THRESHOLD CHANGE AS A KIND OF THE ONE APPROVAL.** Opened from the company's records under the name the page gave
 * and approved only when it changes exactly what the page showed; checked as the change itself is before every send;
 * judged at the bar the chain carries it out at (`thresholdCarryBar`), besides what the proposal held when it was
 * raised; and carried out by the one carry step.
 */
export function thresholdKind(reach: Pick<ChangeThresholdReach, 'pause' | 'waitMs' | 'everyMs'>, which: Which): ProposalKind {
  const kindWhy = (stop: ApprovalStop | string, values?: Readonly<Record<string, string | number>>): Words => why(KIND_WHY[stop] ?? stop, values);
  const kind: ProposalKind = {
    fields: which === 'threshold' ? ['threshold'] : ['threshold', 'vault'],
    changesTheCompany: true,
    shown: async (intent): Promise<readonly ShownLine[]> => [
      { key: 'act.change-threshold.shown.proposal', values: { proposal: intent.fields['proposal'] ?? '' }, from: 'page' },
      which === 'threshold'
        ? { key: 'act.change-threshold.shown.threshold', values: { threshold: intent.fields['threshold'] ?? '' }, from: 'page' }
        : { key: 'act.change-threshold.shown.vault-threshold', values: { threshold: intent.fields['threshold'] ?? '', vault: intent.fields['vault'] ?? '' }, from: 'page' },
      ...consequencesOf(intent, which),
      { key: 'act.change-threshold.shown.checks', from: 'action' },
      { key: 'act.change-threshold.shown.approve', from: 'action' },
    ],
    check: (intent) => {
      const a = askedOf(intent, which);
      return 'key' in a ? a : null;
    },
    opened: async (ctx, r, intent) => {
      const a = askedOf(intent, which);
      if ('key' in a) throw new StepRefused(a);
      const id = intent.fields['proposal']!;
      const doors = doorsOf(r, reach, ctx, { over: false });
      let governance: GovernanceOnTheWire | undefined;
      let chainId: string;
      try {
        const opened = await openTheRoundHere(doors.service, r.accountId, id, r.companyKeys, false, doors.records, doors.leaves, false,
          which === 'threshold' ? 'set-threshold' : 'set-vault-threshold');
        governance = opened.governance as GovernanceOnTheWire | undefined;
        chainId = opened.chainId;
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        throw new StepRefused(kindWhy('not-approved', { says: said(e) }), codeOfError(e));
      }
      if (!isAsked(governance, a)) throw new StepRefused(kindWhy('not-as-shown'));
      return { id, chainId };
    },
    needed: (round, held, intent) => {
      const a = askedOf(intent, which);
      return 'key' in a ? null : Math.max(round.needed ?? 0, thresholdCarryBar(countedOf(a), held));
    },
    approve: async (ctx, r, intent, round, handed) => {
      const a = askedOf(intent, which);
      if ('key' in a) throw new StepRefused(a);
      try {
        await onDevice(doorsOf(r, reach, ctx, handed), r, a, { approveOnly: round.chainId, stopBeforeCarry: true });
      } catch (e) {
        if (e instanceof ApprovalNotOwed || e instanceof WithdrawnWhileSent) throw e;
        stoppedAs(e, handed, 'not-approved', kindWhy);
      }
    },
    stateAt: (atItsBar) => (atItsBar ? CHANGE_THRESHOLD_STATE.atItsBar : CHANGE_THRESHOLD_STATE.waiting),
    carry: (here, read, intent) => [carryStep(kind, intent, read, here, { key: 'act.change-threshold.step.carry' }, carryOutFor(reach, which))],
    why: kindWhy,
  };
  return kind;
}

/**
 * **CHANGING THE APPROVALS NEEDED, IN THE WALLET**: one window and one passkey. The wallet reads the company and this
 * seat, does what the company owes first (the upkeep), checks the change and raises it (or approves the same change
 * already raised), carries it out with the one carry step when the chain counts its bar, and ends with the upkeep's
 * anchor. The page gets back where the proposal got to, its approvals and the approvals it needs, read from the chain.
 */
export function changeThresholdAction(reach: ChangeThresholdReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.change-threshold.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      intent.fields['vault'] === undefined
        ? { key: 'act.change-threshold.shown.threshold', values: { threshold: intent.fields['threshold'] ?? '' }, from: 'page' as const }
        : { key: 'act.change-threshold.shown.vault-threshold', values: { threshold: intent.fields['threshold'] ?? '', vault: intent.fields['vault'] }, from: 'page' as const },
      ...consequencesOf(intent, intent.fields['vault'] === undefined ? 'threshold' : 'vault-threshold'),
      { key: 'act.change-threshold.shown.checks', from: 'action' as const },
      { key: 'act.change-threshold.shown.raise', from: 'action' as const },
      ...upkeepShown(),
      { key: 'act.change-threshold.shown.nothing-else', from: 'action' as const },
    ],
    checks: [
      { key: 'act.change-threshold.check.seat' },
      { key: 'act.change-threshold.check.chain' },
      { key: 'act.change-threshold.check.vaults' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => {
      if (intent.fields['record'] === undefined) return why('not-a-company');
      const a = askedOf(intent, null);
      return 'key' in a ? a : null;
    },
    steps: (intent) => {
      const which: Which = intent.fields['vault'] === undefined ? 'threshold' : 'vault-threshold';
      const kind = thresholdKind(reach, which);
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const here = approving();
      const seat: ActionStep = {
        title: { key: 'act.change-threshold.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const raise: ActionStep = {
        title: { key: 'act.change-threshold.step.raise' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const a = askedOf(intent, which);
          if ('key' in a) throw new StepRefused(a);
          const handed: Handed = { over: false };
          let out: GovernedOutcome;
          try {
            await refuseAThresholdChangeHere(r, a);
            out = await onDevice(doorsOf(r, reach, ctx, handed), r, a, { stopBeforeCarry: true });
          } catch (e) {
            return stoppedAs(e, handed, 'not-raised', why);
          }
          if (out.round === null) throw new StepRefused(why('not-raised', { says: 'The company holds no record of the proposal raised. Nothing more was sent.' }));
          here.round = { id: out.round.id, chainId: String(out.round.chainId).toLowerCase() };
          const now = await onTheChain(r, here.round.chainId);
          const held: AccountGovernance = await r.holders();
          here.standing = now ?? null;
          here.needed = now === undefined ? null : kind.needed(now, held, intent);
          ctx.tell({
            state: out.state === 'ready-to-carry' ? CHANGE_THRESHOLD_STATE.atItsBar : CHANGE_THRESHOLD_STATE.waiting,
            ...(now === undefined ? {} : { approvals: now.approvals }), ...(here.needed === null ? {} : { needed: here.needed }),
          });
        },
      };
      const carry = carryStep(kind, intent, read, here, { key: 'act.change-threshold.step.carry' }, carryOutFor(reach, which));
      return [seat, upkeep.first, raise, carry, upkeep.last];
    },
  } satisfies ActionDefinition);
}

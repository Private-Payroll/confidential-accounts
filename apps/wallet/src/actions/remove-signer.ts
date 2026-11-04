/**
 * **A SIGNER REMOVED, IN THE WALLET**, with or without a new threshold for once they are gone: raised from the seat this
 * wallet holds through the account's `propose` on the removal's payload (`removeAndSetThresholdPayload(leaf, threshold)`,
 * where 0 keeps the threshold in force), approved by the other signers through the one approval (`proposalKinds`, kind
 * `removal`), and carried out by the one carry step through `removeSignerAndSetThreshold` once the chain counts the
 * approvals a change of who is seated needs. At a bar of one the raise is carried out in the same window.
 *
 * The removal itself is the shared device code's (`removeSignerOnDevice`): the retirement of the leaving seat in the
 * company's directory, built and signed at the raise, signed again with every approval, filed and anchored before the
 * chain is asked; the leaving seat's filings judged; the company's key changed once the removal is carried out. This
 * file gives it the wallet's own doors (`removalDoorsFor`) and the checks made before anything is built.
 *
 * Every fact a check rests on is read from the chain through this wallet's own indexer (the seats, the threshold, the
 * bars, the vaults the account holds, and every open run a removal has outrun) or from the company's records this wallet
 * opens (who may approve each vault's runs), never from the service. A removal the chain would refuse when it is carried
 * out, or one that would leave a vault unable to pay, is refused before anything is built, and again before every send:
 * the raise, an approval and the carrying out (`refuseARemovalHere`).
 *
 * **WHERE THE VAULT SECRET'S ROTATION PLUGS IN**: `RemoveSignerReach.afterCarried`, run by the removal's carrying out
 * once the chain has taken the leaf off, from this action and from the one approval alike. Until a rotation is given it
 * holds `WAITS_FOR_THE_ROTATION`, and both this action's check and the one approval's check of a removal refuse before
 * anything is sent: a removal carried out without the rotation would leave the leaving signer holding the vault secrets.
 * No page asks for this action either.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import type { AccountGovernance } from 'midnight-identity/profile/records-key';
import type { Hex } from '../../../../src/core/crypto.js';
import { removalRefusal } from '../../../../src/core/vault-approvers.js';
import type { GovernanceOnTheWire } from '../../../../packages/web-shared/src/governed-call-builder.js';
import {
  ApprovalNotOwed, nothingWasSentBy, removeSignerOnDevice, withCompanyKeys, WithdrawnWhileSent,
  type RemovalDoors, type RemovalOutcome, type ThresholdChangeSteps,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { anchorTheRecordsHere, directoryChangeFiledHere } from '../../../../packages/web-shared/src/records-anchored-here.js';
import { openTheRoundHere } from '../../../../packages/web-shared/src/round-opened-here.js';
import { treeKeptHere } from '../../../../packages/web-shared/src/tree-kept-here.js';
import { attestedIn, leaversStatementIn } from '../../../../packages/web-shared/src/vault-page-doors.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import {
  approversHere, companyReachFor, governanceDoorsFor, keptReach, runsOutrunHere,
  type CompanyChain, type CompanyReach, type Handed,
} from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { approving, carryStep, onTheChain, type ApprovalStop, type CarryOut, type ProposalKind, type RoundHere } from './proposal-kinds.js';
import { ActionStopped } from './run.js';
import { anchorDoorsIn, rotationDoorsIn, UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/**
 * **THE POINT THE VAULT SECRET'S ROTATION PLUGS IN.** Run once for a removal this wallet found carried out on the chain
 * (the leaf taken off, its retirement filed and anchored), after the company's key change was tried, before the step
 * reports. It gets the step's context, the company as this wallet read it, the leaf removed and the proposal that
 * removed it, and `handed`, which it sets once it hands anything over to be sent. A throw stops the step as a carrying
 * out that may have been sent; the removal on the chain stands either way.
 */
export type AfterRemovalCarried = (
  ctx: StepContext, r: CompanyReach, removed: { readonly leaf: Hex; readonly round: { readonly id: string; readonly chainId: string } }, handed: Handed,
) => Promise<void>;

/**
 * What `afterCarried` holds while the wallet has no rotation of the vault secrets: every removal is refused at its check,
 * and again by the raise, an approval and the carrying out, before anything is built or sent, so none is raised,
 * approved or carried out that would leave the leaver holding them.
 */
export const WAITS_FOR_THE_ROTATION = 'waits-for-the-rotation' as const;

/** What the removal reads: the company's chain and builder, the wallet's pause, and the hook the vault secret's rotation takes. */
export interface RemoveSignerReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly waitMs?: number;
  readonly everyMs?: number;
  /** Tests stand in the company read here; the wallet reads it from the chain and the keyring. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
  /** Run once the chain has carried a removal out (`AfterRemovalCarried`); `WAITS_FOR_THE_ROTATION` refuses every removal instead. */
  readonly afterCarried: AfterRemovalCarried | typeof WAITS_FOR_THE_ROTATION;
}

/** Where the page is told the removal got to. */
export const REMOVE_SIGNER_STATE = {
  waiting: 'waiting-for-approvals', atItsBar: 'ready-to-carry', retirement: 'waiting-for-the-retirement', carried: 'carried-out',
} as const;

/** A removal the chain would refuse, or one that would leave a vault unable to pay: refused before anything is built. */
export class RemovalRefused extends Error {
  readonly nothingWasSent = true;
  constructor(why: string) {
    super(`${why.charAt(0).toUpperCase()}${why.slice(1)} Nothing was sent.`);
    this.name = 'RemovalRefused';
  }
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.remove-signer.why.${key}`, ...(values === undefined ? {} : { values }),
});
/** The refusal every removal gets while the wallet has no rotation of the vault secrets to run after it; null once it has. */
const waitsForTheRotation = (reach: Pick<RemoveSignerReach, 'afterCarried'>): Words | null =>
  reach.afterCarried === WAITS_FOR_THE_ROTATION ? why('waits-for-the-rotation') : null;
/**
 * The same refusal, thrown by the raise, an approval and the carrying out before they build anything, so a removal is
 * never sent without the rotation even by a caller that skipped the check.
 */
const refuseUntilTheRotation = (reach: Pick<RemoveSignerReach, 'afterCarried'>): void => {
  const notYet = waitsForTheRotation(reach);
  if (notYet !== null) throw new StepRefused(notYet);
};
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const LEAF = /^[0-9a-f]{64}$/u;
const WHOLE = /^(0|[1-9][0-9]{0,8})$/u;

type Asked = { readonly leaf: Hex; readonly threshold: number };

/** The leaf to remove and the threshold to leave the company at, as the page named them: 0 or none keeps the one in force. */
const askedOf = (intent: ActIntent): Asked | Words => {
  const leaf = intent.fields['leaf'] ?? '';
  const threshold = intent.fields['threshold'] ?? '0';
  if (!LEAF.test(leaf) || !WHOLE.test(threshold)) return why('not-a-removal');
  return { leaf: leaf as Hex, threshold: Number(threshold) };
};

/** Whether a proposal this wallet opened removes exactly the leaf asked, at exactly the threshold asked. */
const isAsked = (g: GovernanceOnTheWire | undefined, a: Asked): boolean =>
  g !== undefined && g.kind === 'remove-signer' && g.leaf.toLowerCase() === a.leaf && Number(g.threshold ?? '0') === a.threshold;

/**
 * **A REMOVAL THE CHAIN WOULD REFUSE, OR ONE THAT WOULD LEAVE A VAULT UNABLE TO PAY, IS REFUSED HERE** (`removalRefusal`),
 * from the seats, the threshold and the bars the chain holds, the vaults the account holds, who may approve each vault's
 * runs as the company's roster says, and every open run a removal has outrun.
 */
export const refuseARemovalHere = async (r: CompanyReach, a: Asked): Promise<void> => {
  const [roster, held] = await Promise.all([approversHere(r, () => runsOutrunHere(r), { removal: true }), r.holders()]);
  const no = removalRefusal(roster, { seats: held.seats, approvals: held.approvals, policyBar: held.policyBar }, a.leaf, a.threshold);
  if (no !== null) throw new RemovalRefused(no);
};

/** Whose seat a removal takes, as the company's list of signers this wallet opened names it: what the person confirms. */
type Leaving = { readonly name: string };

/**
 * Reads whose seat `a` takes from the company's list of signers this wallet opens with the seat's keys, and the lines
 * the window shows for the person to confirm: the name and the leaf, and the threshold it leaves the company at.
 * Refuses a leaf that list holds no seat for, before anything is sent.
 */
const leavingRead = async (r: CompanyReach, a: Asked, whyOf: (k: string, v?: Readonly<Record<string, string>>) => Words): Promise<{ read: Leaving; confirm: Words[] }> => {
  const leaving = (await r.roster()).signers.find((x) => String(x.leafCommitment ?? '').toLowerCase() === a.leaf);
  if (leaving === undefined || typeof leaving.name !== 'string') throw new StepRefused(whyOf('no-such-seat', { leaf: a.leaf }));
  return {
    read: { name: leaving.name },
    confirm: [
      { key: 'act.remove-signer.confirm.removing', values: { name: leaving.name, leaf: a.leaf } },
      a.threshold === 0
        ? { key: 'act.remove-signer.shown.keeps-the-threshold' }
        : { key: 'act.remove-signer.shown.threshold', values: { threshold: a.threshold } },
    ],
  };
};

/** Whose seat the person confirmed, as the first step read it; refused when nothing was read. */
const leavingOf = (round: RoundHere, whyOf: (k: string, v?: Readonly<Record<string, string>>) => Words): Leaving => {
  const read = round.read as Leaving | undefined;
  if (read === undefined || typeof read.name !== 'string') {
    throw new StepRefused(whyOf('not-read'));
  }
  return read;
};

/**
 * **THE WALLET'S DOORS FOR A REMOVAL**: the governance doors every change uses, and what a removal needs beyond them,
 * each from this wallet's own reads: the leaving seat's records-key statement from the roster it opened; the directory
 * change filed and anchored at once, and the directory anchored, through the anchor the upkeep uses; the directory
 * changes kept on this device; and the company's key changed once the removal is carried out. Each that sends sets
 * `handed.over`. The anchor and key doors are read only when a removal reaches them.
 */
export function removalDoorsFor(
  r: CompanyReach, sleep: (ms: number) => Promise<void>, handed: Handed, o: { readonly waitMs?: number; readonly everyMs?: number } = {},
): RemovalDoors {
  let anchor: ReturnType<typeof anchorDoorsIn> | null = null;
  const anchored = () => (anchor ??= anchorDoorsIn(r, r.api));
  let rotation: ReturnType<typeof rotationDoorsIn> | null = null;
  const rotating = () => (rotation ??= rotationDoorsIn(r, r.api));
  return {
    ...governanceDoorsFor(r, sleep, handed, o),
    /* The vault check the shared code runs at the raise, every approval and the carrying out counts every open run. */
    approvers: () => approversHere(r, () => runsOutrunHere(r), { removal: true }),
    leaversStatement: async (seat) => leaversStatementIn(attestedIn(await r.roster()), seat, r.label, r.account),
    directoryChange: async (change, signedFor) => { handed.over = true; return directoryChangeFiledHere(await anchored(), change, signedFor); },
    anchorDirectory: async () => { handed.over = true; return anchorTheRecordsHere(await anchored()); },
    kept: treeKeptHere().changes,
    companyKey: {
      filings: async () => (await rotating()).filings(),
      served: async () => (await rotating()).served(),
      released: () => r.companyKey,
      askTheWallet: async () => r.companyKey,
      waiting: async () => (await rotating()).waiting!(),
      admitted: async () => (await rotating()).admitted!(),
      file: async (change, signedFor) => { handed.over = true; return (await rotating()).file(change, signedFor); },
    },
  };
}

const doorsOf = (r: CompanyReach, reach: Pick<RemoveSignerReach, 'pause' | 'waitMs' | 'everyMs'>, ctx: StepContext, handed: Handed) =>
  removalDoorsFor(r, (ms) => reach.pause(ms, ctx.signal), handed, {
    ...(reach.waitMs === undefined ? {} : { waitMs: reach.waitMs }), ...(reach.everyMs === undefined ? {} : { everyMs: reach.everyMs }),
  });

/**
 * The shared code's removal, with this wallet's check run again before every send. `leaving` is whose seat the person
 * confirmed, read once in the first step: the name the raise seals in its summary, never read again here.
 */
const onDevice = async (doors: RemovalDoors, r: CompanyReach, a: Asked, leaving: Leaving, steps: ThresholdChangeSteps): Promise<RemovalOutcome> =>
  removeSignerOnDevice(doors, withCompanyKeys({
    leaf: a.leaf, name: leaving.name, newThreshold: a.threshold, ...steps, before: () => refuseARemovalHere(r, a),
  }, r.companyKeys));

/** A stop, worded for what was handed over by then. */
const stoppedAs = (e: unknown, handed: Handed, notSent: string, whyOf: (k: string, v?: Readonly<Record<string, string>>) => Words): never => {
  if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
  if (e instanceof RemovalRefused) throw new StepRefused(whyOf('refused', { says: said(e) }), codeOfError(e));
  throw new StepRefused(whyOf(!handed.over || nothingWasSentBy(e) ? notSent : 'may-be-sent', { says: said(e) }), codeOfError(e));
};

/** Carries the removal out, once the carry step has read it at its bar; then the vault secret's rotation. */
const carryOutFor = (reach: Pick<RemoveSignerReach, 'pause' | 'waitMs' | 'everyMs' | 'afterCarried'>): CarryOut => async (ctx, r, intent, round, handed) => {
  refuseUntilTheRotation(reach);
  const a = askedOf(intent);
  if ('key' in a) throw new StepRefused(a);
  const out = await onDevice(doorsOf(r, reach, ctx, handed), r, a, leavingOf(round, why), { approveOnly: round.chainId, carryOnly: true });
  if (out.state === 'waiting-for-the-retirement') return { state: REMOVE_SIGNER_STATE.retirement };
  if (out.state !== 'done') {
    throw Object.assign(new Error('the company\'s records do not show this removal at the approvals it needs yet, so it was not carried out.'), { nothingWasSent: true });
  }
  /* THE VAULT SECRET'S ROTATION RUNS HERE (`AfterRemovalCarried`). The marker never reaches this line: it is refused above. */
  if (typeof reach.afterCarried === 'function') await reach.afterCarried(ctx, r, { leaf: a.leaf, round: { id: round.id, chainId: round.chainId } }, handed);
  return undefined;
};

const KIND_WHY: Readonly<Record<string, string>> = { closed: 'carried-out', counted: 'already-counted' };

/** What the window shows of the removal asked: the leaf, and the threshold it leaves the company at. */
const removalShown = (intent: ActIntent): ShownLine[] => {
  const threshold = intent.fields['threshold'] ?? '0';
  return [
    { key: 'act.remove-signer.shown.leaf', values: { leaf: intent.fields['leaf'] ?? '' }, from: 'page' },
    threshold === '0'
      ? { key: 'act.remove-signer.shown.keeps-the-threshold', from: 'page' }
      : { key: 'act.remove-signer.shown.threshold', values: { threshold }, from: 'page' },
    { key: 'act.remove-signer.shown.retirement', from: 'action' },
    { key: 'act.remove-signer.shown.checks', from: 'action' },
  ];
};

/**
 * **A REMOVAL, AS THE ONE APPROVAL KNOWS IT** (kind `removal`): the proposal opened from the company's records must
 * remove exactly the leaf the page showed at exactly the threshold it showed, and that leaf must be a seat the company's
 * list of signers, as this wallet opens it, holds: the window names whose seat it is from that list, never by the page's
 * word, in the first step and before anything is sent, and goes on only on the person's Confirm; the approval and the
 * carrying out seal the name confirmed. A seat the list does not hold is approved by nobody here; it is judged at the approvals a change of
 * who is seated needs, the higher of that and what the chain's hold says it needed when raised; approving it signs the
 * retirement it carries; it is carried out by the one carry step. While `afterCarried` holds `WAITS_FOR_THE_ROTATION`
 * its check, its approval and its carrying out refuse, so this wallet neither approves nor carries out a removal raised
 * anywhere.
 */
export function removalKind(reach: Pick<RemoveSignerReach, 'pause' | 'waitMs' | 'everyMs' | 'afterCarried'>): ProposalKind {
  const kindWhy = (stop: ApprovalStop | string, values?: Readonly<Record<string, string | number>>): Words => why(KIND_WHY[stop] ?? stop, values);
  const kind: ProposalKind = {
    fields: ['leaf'],
    changesTheCompany: true,
    readsFirst: true,
    shown: async (intent): Promise<readonly ShownLine[]> => [
      { key: 'act.remove-signer.shown.proposal', values: { proposal: intent.fields['proposal'] ?? '' }, from: 'page' },
      ...removalShown(intent),
      { key: 'act.remove-signer.shown.named-here', from: 'action' },
      { key: 'act.remove-signer.shown.approve', from: 'action' },
    ],
    check: (intent) => {
      const notYet = waitsForTheRotation(reach);
      if (notYet !== null) return notYet;
      const a = askedOf(intent);
      return 'key' in a ? a : null;
    },
    opened: async (ctx, r, intent) => {
      const a = askedOf(intent);
      if ('key' in a) throw new StepRefused(a);
      const id = intent.fields['proposal']!;
      const doors = doorsOf(r, reach, ctx, { over: false });
      let governance: GovernanceOnTheWire | undefined;
      let chainId: string;
      try {
        const opened = await openTheRoundHere(doors.service, r.accountId, id, r.companyKeys, false, doors.records, doors.leaves, false, 'remove-signer');
        governance = opened.governance as GovernanceOnTheWire | undefined;
        chainId = opened.chainId;
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        throw new StepRefused(kindWhy('not-approved', { says: said(e) }), codeOfError(e));
      }
      if (!isAsked(governance, a)) throw new StepRefused(kindWhy('not-as-shown'));
      /* Whose seat it is comes from the company's list of signers as this wallet opened it, never from the page. */
      const { read, confirm } = await leavingRead(r, a, kindWhy);
      ctx.show({ key: 'act.remove-signer.over.removing', values: { name: read.name, leaf: a.leaf } });
      return { id, chainId, read, confirm };
    },
    needed: (round, held: AccountGovernance) => Math.max(round.needed ?? 0, held.approvals, held.seatBar),
    approve: async (ctx, r, intent, round, handed) => {
      refuseUntilTheRotation(reach);
      const a = askedOf(intent);
      if ('key' in a) throw new StepRefused(a);
      try {
        await onDevice(doorsOf(r, reach, ctx, handed), r, a, leavingOf(round, kindWhy), { approveOnly: round.chainId, stopBeforeCarry: true });
      } catch (e) {
        if (e instanceof ApprovalNotOwed || e instanceof WithdrawnWhileSent) throw e;
        stoppedAs(e, handed, 'not-approved', kindWhy);
      }
    },
    stateAt: (atItsBar) => (atItsBar ? REMOVE_SIGNER_STATE.atItsBar : REMOVE_SIGNER_STATE.waiting),
    carry: (here, read, intent) => [carryStep(kind, intent, read, here, { key: 'act.remove-signer.step.carry' }, carryOutFor(reach))],
    why: kindWhy,
  };
  return kind;
}

/**
 * **THE REMOVAL ACTION**: read the company and this seat, and whose seat the removal takes from the company's list of
 * signers, which the window shows for the person to confirm before anything is sent; the upkeep, the raise (checked first, then proposed, with this
 * seat's signature over the retirement handed at once), the one carry step, the upkeep again. The page names the
 * company, the leaf and, where it changes, the threshold; it is told where the removal got to, its approvals and the
 * approvals it needs, read from the chain. While `afterCarried` holds `WAITS_FOR_THE_ROTATION` its check refuses
 * before any step, and the raise and the carrying out refuse again, so nothing is raised.
 */
export function removeSignerAction(reach: RemoveSignerReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.remove-signer.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      ...removalShown(intent),
      { key: 'act.remove-signer.shown.raise', from: 'action' as const },
      ...upkeepShown(),
      { key: 'act.remove-signer.shown.nothing-else', from: 'action' as const },
    ],
    checks: [
      { key: 'act.remove-signer.check.seat' },
      { key: 'act.remove-signer.check.chain' },
      { key: 'act.remove-signer.check.vaults' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => {
      const notYet = waitsForTheRotation(reach);
      if (notYet !== null) return notYet;
      if (intent.fields['record'] === undefined) return why('not-a-company');
      const a = askedOf(intent);
      return 'key' in a ? a : null;
    },
    steps: (intent) => {
      const kind = removalKind(reach);
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const here = approving();
      /* Whose seat the person confirmed in the first step, before anything is sent: what the raise seals, as it was shown. */
      let leaving: Leaving | null = null;
      const seat: ActionStep = {
        title: { key: 'act.remove-signer.step.seat' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const a = askedOf(intent);
          if ('key' in a) throw new StepRefused(a);
          /* A removal the chain would refuse is refused here, before the person is asked to confirm it. */
          try {
            await refuseARemovalHere(r, a);
          } catch (e) {
            stoppedAs(e, { over: false }, 'not-raised', why);
          }
          const named = await leavingRead(r, a, (k, v) => why(k === 'no-such-seat' ? 'no-such-seat-to-raise' : k, v));
          await ctx.confirm(named.confirm);
          leaving = named.read;
        },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const raise: ActionStep = {
        title: { key: 'act.remove-signer.step.raise' },
        run: async (ctx) => {
          refuseUntilTheRotation(reach);
          const r = await read.at(ctx);
          const a = askedOf(intent);
          if ('key' in a) throw new StepRefused(a);
          const handed: Handed = { over: false };
          let out: RemovalOutcome;
          try {
            if (leaving === null) throw new StepRefused(why('not-read-to-raise'));
            await refuseARemovalHere(r, a);
            out = await onDevice(doorsOf(r, reach, ctx, handed), r, a, leaving, { stopBeforeCarry: true });
          } catch (e) {
            return stoppedAs(e, handed, 'not-raised', why);
          }
          if (out.state === 'waiting-for-the-retirement') {
            ctx.tell({ state: REMOVE_SIGNER_STATE.retirement });
            return;
          }
          if (out.round === null) throw new StepRefused(why('not-raised', { says: 'The company holds no record of the removal raised. Nothing more was sent.' }));
          here.round = { id: out.round.id, chainId: String(out.round.chainId).toLowerCase(), read: leaving };
          const now = await onTheChain(r, here.round.chainId);
          const held: AccountGovernance = await r.holders();
          here.standing = now ?? null;
          here.needed = now === undefined ? null : kind.needed(now, held, intent);
          ctx.tell({
            state: out.state === 'ready-to-carry' ? REMOVE_SIGNER_STATE.atItsBar : REMOVE_SIGNER_STATE.waiting,
            ...(now === undefined ? {} : { approvals: now.approvals }), ...(here.needed === null ? {} : { needed: here.needed }),
          });
        },
      };
      const carry = carryStep(kind, intent, read, here, { key: 'act.remove-signer.step.carry' }, carryOutFor(reach));
      return [seat, upkeep.first, raise, carry, upkeep.last];
    },
  } satisfies ActionDefinition);
}

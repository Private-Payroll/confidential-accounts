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
 * out, or one that would leave a vault unable to pay, is refused before anything is built (`refuseARemovalHere`, at the
 * first step), and the shared code checks it again before the raise, every approval and the carrying out.
 *
 * **WHERE THE VAULT SECRETS' CHANGE PLUGS IN**: `RemoveSignerReach.afterCarried`, run by the removal's carrying out
 * once the chain has taken the leaf off, from this action and from the one approval alike, on the company read again
 * after its key change; the page is told the key change's state and how many vaults ended in each state. No page asks
 * for this action yet.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import type { AccountGovernance } from 'midnight-identity/profile/records-key';
import type { Hex } from '../../../../src/core/crypto.js';
import { removalRefusal } from '../../../../src/core/vault-approvers.js';
import type { GovernanceOnTheWire } from '../../../../packages/web-shared/src/governed-call-builder.js';
import {
  ApprovalNotOwed, nothingWasSentBy, removalsOpenHere, removeSignerOnDevice, withCompanyKeys, WithdrawnWhileSent,
  type RemovalDoors, type RemovalOutcome, type ThresholdChangeSteps,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { anchorTheRecordsHere, directoryChangeFiledHere } from '../../../../packages/web-shared/src/records-anchored-here.js';
import { openTheRoundHere } from '../../../../packages/web-shared/src/round-opened-here.js';
import { treeKeptHere } from '../../../../packages/web-shared/src/tree-kept-here.js';
import { removalApproversHere } from '../../../../packages/web-shared/src/removal-approvers-here.js';
import { attestedIn, leaversStatementIn } from '../../../../packages/web-shared/src/vault-page-doors.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import {
  approversHere, companyReachFor, governanceDoorsFor, governanceRecordsFor, keptReach, runsOutrunHere,
  type CompanyChain, type CompanyReach, type Handed,
} from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import type { VaultsChangedTold } from './vault-secrets-changed-here.js';
import { approving, carryStep, onTheChain, type ApprovalStop, type CarryOut, type ProposalKind, type RoundHere } from './proposal-kinds.js';
import { ActionStopped } from './run.js';
import { removalReachFor, rosterForARemovalHere, UNREAD_SEAT_NAME } from './roster-for-a-removal.js';
import { anchorDoorsIn, rotationDoorsIn, UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/**
 * **THE POINT THE VAULT SECRETS' CHANGE PLUGS IN.** Run once for a removal this wallet found carried out on the chain
 * (the leaf taken off, its retirement filed and anchored), after the company's key change was tried, before the step
 * reports. It gets the step's context, the company as this wallet reads it again after that key change, and the leaf
 * removed with the proposal that removed it, and answers how many vaults ended in each state. The removal on the chain
 * stands whatever it answers or throws.
 */
export type AfterRemovalCarried = (
  ctx: StepContext, r: CompanyReach, removed: { readonly leaf: Hex; readonly round: { readonly id: string; readonly chainId: string } },
) => Promise<VaultsChangedTold>;

/** What the removal reads: the company's chain and builder, the wallet's pause, and the hook that changes the vault secrets. */
export interface RemoveSignerReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly waitMs?: number;
  readonly everyMs?: number;
  /** Tests stand in the company read here; the wallet reads it from the chain and the keyring. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
  /** Run once the chain has carried a removal out (`AfterRemovalCarried`): changes the vault secrets the signer who left holds. */
  readonly afterCarried: AfterRemovalCarried;
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
 * runs as the company's roster says, counted at the bands of the spending policies in force exactly as the device's check
 * before each send counts them (`removalApproversHere`), and every open run a removal has outrun. The roster is read as
 * a removal reads it (`rosterForARemovalHere`), so a seat it names no one for can still be removed.
 */
export const refuseARemovalHere = async (r: CompanyReach, a: Asked): Promise<void> => {
  const rr = removalReachFor(r, a.leaf);
  const [roster, held] = await Promise.all([removalApproversHere({
    approvers: () => approversHere(rr, () => runsOutrunHere(rr), { removal: true }), records: governanceRecordsFor(rr), accountId: r.accountId,
  }, r.companyKeys), r.holders()]);
  const no = removalRefusal(roster, { seats: held.seats, approvals: held.approvals, policyBar: held.policyBar }, a.leaf, a.threshold);
  if (no !== null) throw new RemovalRefused(no);
};

/** Whose seat a removal takes, as the company's list of signers this wallet opened names it: what the person confirms. */
type Leaving = { readonly name: string };

/**
 * Reads whose seat `a` takes from the company's list of signers this wallet opens with the seat's keys, and the lines
 * the window shows for the person to confirm: the name and the leaf, and the threshold it leaves the company at. A seat
 * the network shows and the list names no one for (`rosterForARemovalHere`) is named by fixed words and its leaf, and
 * those words are the name sealed. Refuses a leaf that list holds no seat for, before anything is sent.
 */
const leavingRead = async (
  r: CompanyReach, a: Asked, whyOf: (k: string, v?: Readonly<Record<string, string>>) => Words,
): Promise<{ read: Leaving; confirm: Words[]; over: Words }> => {
  const roster = await rosterForARemovalHere(r, a.leaf);
  const leaving = roster.leavingUnread ? { name: UNREAD_SEAT_NAME } : roster.signers.find((x) => String(x.leafCommitment ?? '').toLowerCase() === a.leaf);
  if (leaving === undefined || typeof leaving.name !== 'string') throw new StepRefused(whyOf('no-such-seat', { leaf: a.leaf }));
  const named: { readonly confirm: string; readonly over: string; readonly values: Readonly<Record<string, string>> } = roster.leavingUnread
    ? { confirm: 'act.remove-signer.confirm.removing-unread', over: 'act.remove-signer.over.removing-unread', values: { leaf: a.leaf } }
    : { confirm: 'act.remove-signer.confirm.removing', over: 'act.remove-signer.over.removing', values: { name: leaving.name, leaf: a.leaf } };
  return {
    read: { name: leaving.name },
    over: { key: named.over, values: named.values },
    confirm: [
      { key: named.confirm, values: named.values },
      a.threshold === 0
        ? { key: 'act.remove-signer.shown.keeps-the-threshold' }
        : { key: 'act.remove-signer.shown.threshold', values: { threshold: a.threshold } },
    ],
  };
};

/**
 * The line the window adds where a removal of this seat was raised before and closed without being carried out, so the
 * person knows confirming raises a new one. Only words: where that read cannot be made no line is added and nothing is
 * refused, since the device checks the removal in full before every send.
 */
const withdrawnBeforeOf = async (doors: RemovalDoors, r: CompanyReach, a: Asked): Promise<Words[]> => {
  let ids: string[];
  try {
    ids = (await removalsOpenHere(doors, r.companyKeys, false)).filter((x) => x.leaf === a.leaf && x.status === 'cancelled').map((x) => x.id);
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    /* Passed over on purpose: this read only adds words to the Confirm, and a stop here would hold up a removal nothing else holds up. */
    return [];
  }
  return ids.length === 0 ? [] : [{ key: 'act.remove-signer.confirm.withdrawn-before', values: { proposals: ids.join(', ') } }];
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
      revoked: async () => (await rotating()).revoked(),
      file: async (change, signedFor) => { handed.over = true; return (await rotating()).file(change, signedFor); },
    },
  };
}

/** The wallet's doors for the removal of `leaf`, with the roster read as that removal reads it (`removalReachFor`). */
const doorsOf = (r: CompanyReach, reach: Pick<RemoveSignerReach, 'pause' | 'waitMs' | 'everyMs'>, ctx: StepContext, handed: Handed, leaf: Hex) =>
  removalDoorsFor(removalReachFor(r, leaf), (ms) => reach.pause(ms, ctx.signal), handed, {
    ...(reach.waitMs === undefined ? {} : { waitMs: reach.waitMs }), ...(reach.everyMs === undefined ? {} : { everyMs: reach.everyMs }),
  });

/**
 * The shared code's removal, which checks the company itself before every send. `leaving` is whose seat the person
 * confirmed, read once in the first step: the name the raise seals in its summary, never read again here.
 */
const onDevice = async (doors: RemovalDoors, r: CompanyReach, a: Asked, leaving: Leaving, steps: ThresholdChangeSteps): Promise<RemovalOutcome> =>
  removeSignerOnDevice(doors, withCompanyKeys({ leaf: a.leaf, name: leaving.name, newThreshold: a.threshold, ...steps }, r.companyKeys));

/** A stop, worded for what was handed over by then. */
const stoppedAs = (e: unknown, handed: Handed, notSent: string, whyOf: (k: string, v?: Readonly<Record<string, string>>) => Words): never => {
  if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
  if (e instanceof RemovalRefused) throw new StepRefused(whyOf('refused', { says: said(e) }), codeOfError(e));
  throw new StepRefused(whyOf(!handed.over || nothingWasSentBy(e) ? notSent : 'may-be-sent', { says: said(e) }), codeOfError(e));
};

/**
 * Carries the removal out, once the carry step has read it at its bar; then changes the vault secrets on the company read
 * again, and tells the page the company key's change and how many vaults ended in each state. A change that could not
 * start is told as `not-started`: the removal stands, and the next upkeep or a press of the change finishes it.
 */
const carryOutFor = (reach: Pick<RemoveSignerReach, 'pause' | 'waitMs' | 'everyMs' | 'afterCarried'>): CarryOut => async (ctx, r, intent, round, handed, renewed) => {
  const a = askedOf(intent);
  if ('key' in a) throw new StepRefused(a);
  const out = await onDevice(doorsOf(r, reach, ctx, handed, a.leaf), r, a, leavingOf(round, why), { approveOnly: round.chainId, carryOnly: true });
  if (out.state === 'waiting-for-the-retirement') return { state: REMOVE_SIGNER_STATE.retirement };
  if (out.state !== 'done') {
    throw Object.assign(new Error('the company\'s records do not show this removal at the approvals it needs yet, so it was not carried out.'), { nothingWasSent: true });
  }
  ctx.tell({ rotation: out.rotation?.state ?? 'not-tried' });
  try {
    ctx.tell({ ...(await reach.afterCarried(ctx, await renewed(), { leaf: a.leaf, round: { id: round.id, chainId: round.chainId } })) });
  } catch (e) {
    /*
     * The chain has carried the removal out, so nothing here undoes it or hides it: whatever stopped the change, a person's
     * Stop included, the removal is told as carried out and the change as not started. A Stop still ends the action at
     * the next step; the change is made by a staying signer's press, or finished by the upkeep where it was raised.
     * What kind of stop it was is told as a code, never its message, which the page's outcome cannot carry; a Stop
     * the person pressed is told with none.
     */
    ctx.tell(e instanceof ActionStopped ? { vaultSecrets: 'not-started' } : { vaultSecrets: 'not-started', vaultSecretsWhy: codeOfError(e) });
  }
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
    { key: 'act.remove-signer.shown.other-changes', from: 'action' },
    { key: 'act.remove-signer.shown.open-runs', from: 'action' },
    { key: 'act.remove-signer.shown.checks', from: 'action' },
    { key: 'act.remove-signer.shown.vault-secrets', from: 'action' },
  ];
};

/**
 * **A REMOVAL, AS THE ONE APPROVAL KNOWS IT** (kind `removal`): the proposal opened from the company's records must
 * remove exactly the leaf the page showed at exactly the threshold it showed, and that leaf must be a seat the company's
 * list of signers, as this wallet opens it, holds: the window names whose seat it is from that list, never by the page's
 * word, in the first step and before anything is sent, and goes on only on the person's Confirm; the approval and the
 * carrying out seal the name confirmed. A seat the list does not hold is approved by nobody here; it is judged at the approvals a change of
 * who is seated needs, the higher of that and what the chain's hold says it needed when raised; approving it signs the
 * retirement it carries; it is carried out by the one carry step, which then changes the vault secrets
 * (`afterCarried`).
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
      const a = askedOf(intent);
      return 'key' in a ? a : null;
    },
    opened: async (ctx, r, intent) => {
      const a = askedOf(intent);
      if ('key' in a) throw new StepRefused(a);
      const id = intent.fields['proposal']!;
      const doors = doorsOf(r, reach, ctx, { over: false }, a.leaf);
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
      const { read, confirm, over } = await leavingRead(r, a, kindWhy);
      ctx.show(over);
      return { id, chainId, read, confirm };
    },
    needed: (round, held: AccountGovernance) => Math.max(round.needed ?? 0, held.approvals, held.seatBar),
    approve: async (ctx, r, intent, round, handed) => {
          const a = askedOf(intent);
      if ('key' in a) throw new StepRefused(a);
      try {
        await onDevice(doorsOf(r, reach, ctx, handed, a.leaf), r, a, leavingOf(round, kindWhy), { approveOnly: round.chainId, stopBeforeCarry: true });
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
 * approvals it needs, read from the chain, and, once it is carried out, the company key's change and how many vaults
 * ended in each state of their secret's change.
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
          await ctx.confirm([...named.confirm, ...await withdrawnBeforeOf(doorsOf(r, reach, ctx, { over: false }, a.leaf), r, a)]);
          leaving = named.read;
        },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const raise: ActionStep = {
        title: { key: 'act.remove-signer.step.raise' },
        run: async (ctx) => {
                  const r = await read.at(ctx);
          const a = askedOf(intent);
          if ('key' in a) throw new StepRefused(a);
          const handed: Handed = { over: false };
          let out: RemovalOutcome;
          try {
            if (leaving === null) throw new StepRefused(why('not-read-to-raise'));
            out = await onDevice(doorsOf(r, reach, ctx, handed, a.leaf), r, a, leaving, { stopBeforeCarry: true });
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

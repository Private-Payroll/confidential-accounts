import type { ActIntent } from 'midnight-identity/profile/request';
import { readVaultAddress } from 'midnight-identity/profile/company-label';
import { assets as theAssets, formatAmount, type AssetId, type AssetRegistry, type LedgerForm } from '../../../../src/core/assets.js';
import { fromHex, randomBytes, signingPublicKeyOf, toHex, type Hex } from '../../../../src/core/crypto.js';
import { canonicalPeriod, legChoiceOf, legEmployees, legOf, listOfRun } from '../../../../src/core/run-legs.js';
import type { Employee, PayrollRun, RunLeg, RunList } from '../../../../src/core/types.js';
import { buildRetryRun, buildRun, rootOfPayments } from '../../../../src/midnight/payout-tree.js';
import {
  ApprovalNotOwed, approveOnDevice, governedCallServiceFor, nothingWasSentBy, raiseRetryOnDevice, raiseRunOnDevice, sendRaiseFromDevice,
  sendRetryFromDevice, theRoundAsked, withCompanyKeys, type RoundOnThePage,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { fileRunDrawnHere, runDrawnHere, samePeopleAsDrawn, type RunDrawDoors } from '../../../../packages/web-shared/src/run-drawn-here.js';
import type { LegRaiseDoors } from '../../../../packages/web-shared/src/run-raised-here.js';
import { openTheRoundHere } from '../../../../packages/web-shared/src/round-opened-here.js';
import { keptRunHere, payrollRoundsHere, proposalsListedHere } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import {
  companyReachFor, companyRecordsFor, enteredFor, keptReach, pureCircuits, type CompanyReach, type CompanyRecordsInTheWallet, type Handed,
  type PureCircuits,
} from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { governedDoorsFor, oneOffNeeded, raiseDoorsFor, type OneOffPaymentReach } from './one-off-payment.js';
import { onTheChain, type ApprovalStop, type ProposalKind } from './proposal-kinds.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/*
 * A PAYROLL RUN RAISED IN THE WALLET: one window and one passkey. With no run named, the page names no people or total:
 * after the passkey the wallet draws the run over the company's people (or vendors) as this wallet reads and judges
 * them, filing nothing, shows the leg it would raise (month, list, vault, currency and form, people and total) and asks
 * Confirm in the same window. Stop ends the action with nothing filed or raised; Confirm files the run sealed under the
 * company key, reading the month's runs and rounds again first. It then opens the run, refuses it unless the leg (or the retry of some of its people) pays exactly what the page
 * showed, and raises it through the shared raise (`raiseRunOnDevice`, `raiseRetryOnDevice`), which checks the run
 * against the company's records and the vault's money, private and public, on this device before anything is built.
 * Named with a proposal the company wrote down and the chain never held, it sends that one again
 * (`sendRaiseFromDevice`, `sendRetryFromDevice`), checked the same way. A run's payment window comes from the page and
 * must open after now: a run whose window has opened can no longer be withdrawn. Approving a run raised elsewhere is the
 * `payroll` kind of the one approval (`payrollKind`, through `approve-proposal`).
 */

/** What a payroll run raised in the wallet may reach beyond the one-off payment's doors. */
export type RaiseRunReach = OneOffPaymentReach & {
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
};

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.raise-run.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\.\s*$/u, '');

export const RAISE_RUN_STATE = { raised: 'raised' } as const;

const HEX64 = /^[0-9a-f]{64}$/u;
const WHOLE = /^[1-9][0-9]*$/u;
const SECONDS = /^[0-9]+$/u;
const INDICES = /^(0|[1-9][0-9]{0,5})(,(0|[1-9][0-9]{0,5})){0,999}$/u;
const FORMS: Readonly<Record<string, LedgerForm>> = { private: 'shielded', public: 'unshielded' };

/** A payroll run as the page shows it: what is checked against the run this wallet opens before anything is raised or approved. */
export interface RunShown {
  readonly run?: string;
  readonly period: string;
  readonly list: RunList;
  readonly vault: Hex;
  readonly asset: AssetId;
  readonly form: LedgerForm;
  readonly payees: number;
  readonly total: bigint;
}

/** A run the wallet is asked to draw: the page names no run, and no people or total, which the wallet shows after the draw. */
export interface RunToDraw extends Omit<RunShown, 'run' | 'payees' | 'total'> {
  readonly run?: undefined;
  readonly payees?: undefined;
  readonly total?: undefined;
}

/** What the page asks the wallet to raise, read from its fields. */
export type RunAsked = (RunShown | RunToDraw) & {
  readonly opensAt?: bigint;
  readonly closesAt?: bigint;
  readonly indices?: readonly number[];
  readonly proposal?: string;
};

/** Whether the page names the run it shows, with its people and total, rather than asking the wallet to draw one. */
const isShown = (a: RunAsked): a is RunShown & RunAsked => a.payees !== undefined && a.total !== undefined;

/** The run the page shows, read from its fields, or the words of why it is not one. */
export function runShownOf(intent: ActIntent): RunShown | Words {
  return runOf(intent, true) as RunShown | Words;
}

/** The run the page shows, or with `counted` false a run to draw, which names no people or total. */
const runOf = (intent: ActIntent, counted: boolean): RunShown | RunToDraw | Words => {
  const f = intent.fields;
  const vault = readVaultAddress(f['vault']);
  if (vault === null) return why('not-a-run', { says: 'it names no vault to pay it from' });
  if (f['token'] === undefined || !HEX64.test(f['token'])) return why('not-a-run', { says: 'it names no currency' });
  const form = FORMS[f['form'] ?? ''];
  if (form === undefined) return why('not-a-run', { says: 'it does not say whether the payments are private or public' });
  if (counted) {
    if (!WHOLE.test(f['payees'] ?? '') || f['payees']!.length > 6) return why('not-a-run', { says: 'it does not say how many people it pays' });
    if (!WHOLE.test(f['total'] ?? '')) return why('not-a-run', { says: 'it does not say what it pays in all' });
  } else if (f['payees'] !== undefined || f['total'] !== undefined) {
    return why('not-a-run', {
      says: 'it gives people or a total for a run it does not name. A run the page does not name is drawn here and its people and total are shown here, so leave them out, or name the run they belong to',
    });
  }
  let period: string;
  try {
    period = canonicalPeriod(f['period'] ?? '');
  } catch {
    return why('not-a-run', { says: 'it names no month the run pays for' });
  }
  const list = (f['list'] ?? 'employees') as RunList;
  if (list !== 'employees' && list !== 'vendors') return why('not-a-run', { says: 'it pays neither the employees nor the vendors' });
  const run = { period, list, vault: vault as Hex, asset: f['token'] as AssetId, form };
  if (!counted) return run;
  return { ...(f['run'] === undefined ? {} : { run: f['run'] }), ...run, payees: Number(f['payees']), total: BigInt(f['total']!) };
};

/** What the page asks to raise, read from its fields: the run shown, and its window, the people a retry pays or the proposal sent again. */
export function runAskedOf(intent: ActIntent): RunAsked | Words {
  const f = intent.fields;
  if (f['run'] === undefined && f['proposal'] !== undefined) return why('not-a-run', { says: 'a proposal is sent again only beside the run it raises. Name that run' });
  if (f['run'] === undefined && f['indices'] !== undefined) return why('not-a-run', { says: 'a retry pays people of a run already raised. Name that run' });
  const shown = runOf(intent, f['run'] !== undefined);
  if ('key' in shown) return shown;
  if (f['proposal'] !== undefined) {
    if (f['indices'] !== undefined) return why('not-a-run', { says: 'a proposal sent again keeps the people it was written down with' });
  }
  if (f['opensAt'] === undefined || f['closesAt'] === undefined || !SECONDS.test(f['opensAt']) || !SECONDS.test(f['closesAt'])) {
    return why('no-window');
  }
  const opensAt = BigInt(f['opensAt']);
  const closesAt = BigInt(f['closesAt']);
  if (opensAt >= closesAt) return why('no-window');
  if (f['proposal'] !== undefined) return { ...shown, opensAt, closesAt, proposal: f['proposal'] };
  if (f['indices'] === undefined) return { ...shown, opensAt, closesAt };
  if (!INDICES.test(f['indices'])) return why('not-a-run', { says: 'it does not say which of the run\'s people the retry pays' });
  const indices = f['indices'].split(',').map(Number);
  if (!isShown(shown) || new Set(indices).size !== indices.length || indices.length !== shown.payees) {
    return why('not-a-run', { says: 'the people the retry pays are not the number of people it shows' });
  }
  return { ...shown, opensAt, closesAt, indices };
}

/** A window that opens at or before now is refused: a run whose window has opened can no longer be withdrawn. */
const windowOpenRefusal = (opensAt: bigint, nowMs: number): Words | null =>
  opensAt <= BigInt(Math.floor(nowMs / 1000)) ? why('window-open', { opensAt: new Date(Number(opensAt) * 1000).toISOString() }) : null;

/** The people a raise, a retry or a raise sent again pays, the vault and the window it was written down with, as the run opened here holds them. */
interface RunPart {
  readonly people: readonly Employee[];
  readonly vault?: Hex;
  readonly opensAt?: bigint;
  readonly closesAt?: bigint;
  readonly retry: boolean;
}

/** Which part of the run this is: the leg, a retry of some of its people, or a proposal written down for one of them. */
const partOf = (run: PayrollRun, leg: RunLeg, asked: Pick<RunAsked, 'indices' | 'proposal'>): RunPart | string => {
  const onTheLeg = legEmployees(run, leg);
  const recorded = run.payout?.[leg];
  if (asked.proposal !== undefined) {
    if (run.proposalIds?.[leg] === asked.proposal && recorded !== undefined) {
      return { people: onTheLeg, vault: recorded.vault, opensAt: recorded.opensAt, closesAt: recorded.closesAt, retry: false };
    }
    const retry = recorded?.retries?.find((x) => x.proposalId === asked.proposal);
    if (retry === undefined) return 'the run holds no proposal by that name for this leg';
    return { people: retry.originalIndices.map((i) => onTheLeg[i]!), vault: retry.vault, opensAt: retry.opensAt, closesAt: retry.closesAt, retry: true };
  }
  if (asked.indices !== undefined) {
    if (asked.indices.some((i) => i >= onTheLeg.length)) return 'the retry names a person the run does not pay';
    return { people: asked.indices.map((i) => onTheLeg[i]!), ...(recorded === undefined ? {} : { vault: recorded.vault }), retry: true };
  }
  return { people: onTheLeg, retry: false };
};

/** Where the run opened here differs from what the page showed, in words, or null when it is exactly that. */
export const runNotAsShown = (run: PayrollRun, part: RunPart, shown: RunShown & Pick<RunAsked, 'opensAt' | 'closesAt'>): string | null => {
  if (shown.run !== undefined && run.id !== shown.run) return 'it is another run';
  if (listOfRun(run) !== shown.list) return `it pays the company's ${listOfRun(run)}, not its ${shown.list}`;
  if (run.period !== shown.period) return `it pays for ${run.period}, not ${shown.period}`;
  if (part.people.length !== shown.payees) return `it pays ${part.people.length} people, not ${shown.payees}`;
  const total = part.people.reduce((a, e) => a + e.amount, 0n);
  if (total !== shown.total) return 'it pays another total';
  if (part.vault !== undefined && part.vault.toLowerCase() !== shown.vault.toLowerCase()) return 'it pays from another vault';
  if (part.opensAt !== undefined && shown.opensAt !== undefined && (BigInt(part.opensAt) !== shown.opensAt || BigInt(part.closesAt ?? -1n) !== shown.closesAt)) {
    return 'it was written down with another payment window';
  }
  return null;
};

/** The doors a run is raised through: the one-off's raise doors, the one records door, a fresh salt for every raise, and the account's own circuits. */
export function raiseRunDoorsFor(
  ctx: StepContext, r: CompanyReach, reach: RaiseRunReach, records: CompanyRecordsInTheWallet, pure: PureCircuits, handed: Handed,
): LegRaiseDoors {
  const base = raiseDoorsFor(ctx, r, reach, records, pure, handed);
  return {
    ...base,
    records,
    filing: {
      ...base.filing, salt: () => toHex(randomBytes(32)),
      newId: () => { const id = base.filing.newId(); ctx.tell({ proposal: id }); return id; },
    },
    company: { account: r.account, label: r.label },
    runs: {
      detailsOf: pure.details, buildRun, buildRetryRun, rootOfPayments,
      runPayload: pure.account.runPayload, proposalIdOf: pure.account.proposalIdOf, retrySaltOf: pure.account.retrySaltOf, noVault: pure.account.noVault,
    },
  };
}

/**
 * The doors a run is drawn and filed through: the company's records as this wallet reads them, sealed under the company
 * key when filed; nothing of it goes to the service in the clear. With them, this seat's filing key as a run it filed
 * names it, so the run read back can be checked as this seat's own filing.
 */
const drawnHere = (r: CompanyReach, reach: RaiseRunReach, records: CompanyRecordsInTheWallet): { readonly doors: RunDrawDoors; readonly filer: string } => ({
  doors: withCompanyKeys({
    api: r.api, accountId: r.accountId, keyEpoch: r.companyKeys.epoch, signingSecret: r.seat.signingSecret as Hex,
    company: { account: r.account, label: r.label }, records, by: r.leaf,
    registry: reach.assets ?? theAssets, now: () => new Date(reach.now()).toISOString(), entered: enteredFor(r),
  }, r.companyKeys),
  filer: signingPublicKeyOf(r.seat.signingSecret as Hex).toLowerCase(),
});

/** A run drawn in the window, not yet filed, and what the person confirmed of it: the leg the page asked for, with the people and total the draw gave it. */
interface DrawnAndConfirmed {
  readonly run: PayrollRun;
  readonly shown: RunShown;
}

/**
 * What the person confirms of a run drawn in the window, in plain lines: the run's name, its list, month and vault, the
 * currency and form of the leg raised, its people and total, how many more people the run pays in other legs (filed with
 * it, raised separately), each person the draw set aside and why, the payment window, and what Confirm and Stop do.
 */
const drawnLines = (run: PayrollRun, shown: RunShown & Pick<RunAsked, 'opensAt' | 'closesAt'>, registry: AssetRegistry): Words[] => {
  const asset = registry.find(shown.asset);
  const privately = shown.form === 'shielded';
  const others = run.employees.length - shown.payees;
  return [
    { key: 'act.raise-run.confirm.drawn', values: { run: run.id } },
    { key: shown.list === 'vendors' ? 'act.raise-run.confirm.list-vendors' : 'act.raise-run.confirm.list-employees' },
    { key: 'act.raise-run.confirm.period', values: { period: shown.period } },
    { key: 'act.raise-run.confirm.vault', values: { vault: shown.vault } },
    asset === null
      ? { key: privately ? 'act.raise-run.confirm.token-raw-private' : 'act.raise-run.confirm.token-raw-public', values: { token: shown.asset } }
      : { key: privately ? 'act.raise-run.confirm.token-private' : 'act.raise-run.confirm.token-public', values: { symbol: asset.symbol } },
    { key: 'act.raise-run.confirm.payees', values: { payees: shown.payees } },
    asset === null
      ? { key: 'act.raise-run.confirm.total-raw', values: { total: shown.total.toString(), token: shown.asset } }
      : { key: 'act.raise-run.confirm.total', values: { shown: formatAmount(shown.total, asset), symbol: asset.symbol } },
    ...(others > 0 ? [{ key: 'act.raise-run.confirm.others', values: { others } }] : []),
    ...(run.skips?.people ?? []).map((p) => ({ key: 'act.raise-run.confirm.set-aside', values: { name: p.name, why: p.waiting } })),
    ...(shown.opensAt === undefined || shown.closesAt === undefined ? [] : [{
      key: 'act.raise-run.confirm.window',
      values: { opensAt: new Date(Number(shown.opensAt) * 1000).toISOString(), closesAt: new Date(Number(shown.closesAt) * 1000).toISOString() },
    }]),
    { key: 'act.raise-run.confirm.ask' },
  ];
};

const refusedAfter = (e: unknown, handed: Handed): never => {
  if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
  throw new StepRefused(why(!handed.over || nothingWasSentBy(e) ? 'not-raised' : 'raise-may-be-sent', { says: said(e) }));
};

/**
 * The lines that show the run, each as the page's, and what its form makes public. With `toDraw` (a raise that names no
 * run) the page names no people or total, so neither is shown here: the wallet shows them after the draw.
 */
export const runShownLines = (intent: ActIntent, registry: AssetRegistry, prefix: string, toDraw = false): ShownLine[] => {
  const f = intent.fields;
  const asset = f['token'] === undefined || !HEX64.test(f['token']) ? null : registry.find(f['token'] as AssetId);
  const total = f['total'] ?? '';
  return [
    ...(f['run'] === undefined ? [] : [{ key: `${prefix}.run`, values: { run: f['run'] }, from: 'page' as const }]),
    { key: (f['list'] ?? 'employees') === 'vendors' ? `${prefix}.list-vendors` : `${prefix}.list-employees`, from: 'page' as const },
    { key: `${prefix}.period`, values: { period: f['period'] ?? '' }, from: 'page' as const },
    ...(toDraw ? [] : [
      { key: `${prefix}.payees`, values: { payees: f['payees'] ?? '' }, from: 'page' as const },
      asset === null || !SECONDS.test(total)
        ? { key: `${prefix}.total-raw`, values: { total, token: f['token'] ?? '' }, from: 'page' as const }
        : { key: `${prefix}.total`, values: { shown: formatAmount(BigInt(total), asset), symbol: asset.symbol }, from: 'page' as const },
    ]),
    { key: `${prefix}.vault`, values: { vault: f['vault'] ?? '' }, from: 'page' as const },
    ...(FORMS[f['form'] ?? ''] === 'unshielded' ? [{ key: `${prefix}.public`, from: 'action' as const }]
      : FORMS[f['form'] ?? ''] === 'shielded' ? [{ key: `${prefix}.private`, from: 'action' as const }] : []),
  ];
};

/** The approvals the run's vault needs read from the chain, or null when the chain does not hold it yet. */
const neededOnTheChain = async (r: CompanyReach, chainId: string, vault: string): Promise<{ approvals: number; needed: number | null } | null> => {
  const now = await onTheChain(r, chainId.toLowerCase());
  if (now === undefined || now.held === 'never') return null;
  return { approvals: now.approvals, needed: oneOffNeeded(now, await r.holders(), vault) };
};

export function raiseRunAction(reach: RaiseRunReach): ActionDefinition {
  const registry = reach.assets ?? theAssets;
  return Object.freeze({
    headline: 'act.raise-run.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => {
      const f = intent.fields;
      return [
        ...(f['proposal'] === undefined ? [] : [{ key: 'act.raise-run.shown.resend', values: { proposal: f['proposal'] }, from: 'page' as const }]),
        ...runShownLines(intent, registry, 'act.raise-run.shown', f['run'] === undefined),
        ...(f['opensAt'] === undefined || f['closesAt'] === undefined || !SECONDS.test(f['opensAt']) || !SECONDS.test(f['closesAt']) ? [] : [{
          key: 'act.raise-run.shown.window', from: 'page' as const,
          values: { opensAt: new Date(Number(f['opensAt']) * 1000).toISOString(), closesAt: new Date(Number(f['closesAt']) * 1000).toISOString() },
        }]),
        ...(f['indices'] === undefined ? [] : [{ key: 'act.raise-run.shown.retry', from: 'action' as const }]),
        ...(f['indices'] !== undefined && FORMS[f['form'] ?? ''] === 'unshielded' ? [{ key: 'act.raise-run.shown.public-again', from: 'action' as const }] : []),
        ...(f['run'] === undefined ? [{ key: 'act.raise-run.shown.draw', from: 'action' as const }] : [{ key: 'act.raise-run.shown.matched', from: 'action' as const }]),
        { key: 'act.raise-run.shown.raise', from: 'action' as const },
        ...upkeepShown(),
        { key: 'act.raise-run.shown.nothing-else', from: 'action' as const },
      ];
    },
    checks: [
      { key: 'act.raise-run.check.seat' },
      { key: 'act.raise-run.check.run' },
      { key: 'act.raise-run.check.window' },
      { key: 'act.raise-run.check.vault' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => {
      if (intent.fields['record'] === undefined) return why('not-a-company');
      const asked = runAskedOf(intent);
      if ('key' in asked) return asked;
      return asked.opensAt === undefined ? null : windowOpenRefusal(asked.opensAt, reach.now());
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      /* The run drawn and confirmed in the seat step, before anything is sent or filed; null when the page names the run. */
      let drawn: DrawnAndConfirmed | null = null;
      const seat: ActionStep = {
        title: { key: intent.fields['run'] === undefined ? 'act.raise-run.step.seat-and-confirm' : 'act.raise-run.step.seat' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const asked = runAskedOf(intent);
          if ('key' in asked) throw new StepRefused(asked);
          if (isShown(asked)) return;
          const early = asked.opensAt === undefined ? null : windowOpenRefusal(asked.opensAt, reach.now());
          if (early !== null) throw new StepRefused(early);
          let here: DrawnAndConfirmed;
          try {
            const records = companyRecordsFor(r, reach, await pureCircuits());
            const run = await runDrawnHere(drawnHere(r, reach, records).doors, { period: asked.period, list: asked.list });
            const people = legEmployees(run, legOf(run, legChoiceOf({ asset: asked.asset, form: asked.form }), registry));
            const shown: RunShown = { ...asked, run: run.id, payees: people.length, total: people.reduce((a, e) => a + e.amount, 0n) };
            const differs = runNotAsShown(run, { people, retry: false }, shown);
            if (differs !== null) throw new StepRefused(why('not-as-shown', { says: differs }));
            here = { run, shown };
          } catch (e) {
            return refusedAfter(e, { over: false });
          }
          await ctx.confirm(drawnLines(here.run, { ...here.shown, opensAt: asked.opensAt, closesAt: asked.closesAt }, registry));
          drawn = here;
        },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const raise: ActionStep = {
        title: { key: 'act.raise-run.step.raise' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const fromThePage = runAskedOf(intent);
          if ('key' in fromThePage) throw new StepRefused(fromThePage);
          /* A run to draw is raised only as the person confirmed it in the seat step; nothing else is ever raised in its place. */
          if (!isShown(fromThePage) && drawn === null) throw new ActionStopped('step-failed');
          const asked: RunShown & RunAsked = drawn === null ? fromThePage as RunShown & RunAsked : { ...fromThePage, ...drawn.shown };
          const early = asked.opensAt === undefined ? null : windowOpenRefusal(asked.opensAt, reach.now());
          if (early !== null) throw new StepRefused(early);
          const handed: Handed = { over: false };
          let round: RoundOnThePage;
          try {
            const pure = await pureCircuits();
            const records = companyRecordsFor(r, reach, pure);
            const drawing = drawn === null ? null : drawnHere(r, reach, records);
            const runId = drawn === null || drawing === null ? asked.run! : (await fileRunDrawnHere(drawing.doors, drawn.run)).id;
            ctx.tell({ run: runId, ...(asked.proposal === undefined ? {} : { proposal: asked.proposal }) });
            const { sealed, run } = await keptRunHere(records, r.accountId, runId, r.companyKeys);
            /* A run drawn here is raised only as this seat filed it and the person confirmed it: the same people, each at the same pay. */
            if (drawn !== null && drawing !== null) {
              if (sealed.filedBy?.publicKey.toLowerCase() !== drawing.filer) {
                throw new StepRefused(why('not-as-shown', { says: 'the company\'s records hold it as filed by another seat than yours' }));
              }
              if (!samePeopleAsDrawn(run, drawn.run)) throw new StepRefused(why('not-as-shown', { says: 'it pays other people than the run you confirmed' }));
            }
            const leg = legOf(run, legChoiceOf({ asset: asked.asset, form: asked.form }), registry);
            const part = partOf(run, leg, asked);
            if (typeof part === 'string') throw new StepRefused(why('not-as-shown', { says: part }));
            const differs = runNotAsShown(run, part, asked);
            if (differs !== null) throw new StepRefused(why('not-as-shown', { says: differs }));
            if (asked.proposal !== undefined && part.opensAt !== undefined) {
              const opened = windowOpenRefusal(part.opensAt, reach.now());
              if (opened !== null) throw new StepRefused(opened);
            }
            const doors = raiseRunDoorsFor(ctx, r, reach, records, pure, handed);
            const which = withCompanyKeys({ runId, asset: asked.asset, form: asked.form }, r.companyKeys);
            const window = { vault: asked.vault, opensAt: String(asked.opensAt), closesAt: String(asked.closesAt) };
            round = asked.proposal !== undefined
              ? await (part.retry ? sendRetryFromDevice(doors, { ...which, proposalId: asked.proposal }) : sendRaiseFromDevice(doors, which))
              : asked.indices !== undefined
                ? await raiseRetryOnDevice(doors, { ...which, ...window, indices: asked.indices })
                : await raiseRunOnDevice(doors, { ...which, ...window });
          } catch (e) {
            return refusedAfter(e, handed);
          }
          const standing = await neededOnTheChain(r, round.chainId, asked.vault);
          ctx.tell({
            state: RAISE_RUN_STATE.raised, proposal: round.id,
            ...(standing === null ? {} : { approvals: standing.approvals, ...(standing.needed === null ? {} : { needed: standing.needed }) }),
          });
        },
      };
      return [seat, upkeep.first, raise, upkeep.last];
    },
  } satisfies ActionDefinition);
}

const payrollWhy = (stop: ApprovalStop | string, values?: Readonly<Record<string, string | number>>): Words => {
  const key = ({ closed: 'run-closed', counted: 'run-already-counted', 'not-raised': 'run-not-raised', 'not-carried': 'not-approved' } as Record<string, string>)[stop] ?? stop;
  return { key: `act.approve-proposal.why.${key}`, ...(values === undefined ? {} : { values }) };
};

/**
 * **A PAYROLL RUN, APPROVED IN THE WALLET** through the one approval (`approve-proposal`, kind `payroll`). The
 * proposal is found among the company's payroll rounds this wallet opens, its run opened from the company's records,
 * and nothing is approved unless the leg or the retry it raises pays exactly what the page showed. The approval itself
 * (`approveOnDevice`) opens the proposal again with every raise check and the check of who raised it. A run is paid by
 * `pay-run`; this kind carries nothing out.
 */
export function payrollKind(reach: RaiseRunReach): ProposalKind {
  const registry = reach.assets ?? theAssets;
  /* The vault each proposal opened here pays from, as its own sealed record names it and its chain identity binds it: the bar is that vault's. */
  const vaultOf = new Map<string, string>();
  return {
    fields: ['period', 'vault', 'token', 'form', 'payees', 'total'],
    changesTheCompany: false,
    shown: async (intent) => [
      { key: 'act.raise-run.shown.resend', values: { proposal: intent.fields['proposal'] ?? '' }, from: 'page' as const },
      ...runShownLines(intent, registry, 'act.raise-run.shown'),
      { key: 'act.approve-proposal.shown.run-matched', from: 'action' as const },
      { key: 'act.approve-proposal.shown.run-approve', from: 'action' as const },
    ],
    check: (intent) => {
      const shown = runShownOf(intent);
      return 'key' in shown ? payrollWhy('not-a-run', shown.values) : null;
    },
    opened: async (_ctx, r, intent) => {
      const shown = runShownOf(intent);
      if ('key' in shown) throw new StepRefused(payrollWhy('not-a-run', shown.values));
      const named = intent.fields['proposal']!;
      try {
        const pure = await pureCircuits();
        const records = companyRecordsFor(r, reach, pure);
        const rounds = payrollRoundsHere(await proposalsListedHere(records), r.accountId, r.companyKeys, {
          identity: records.roundIdentity, nowInSeconds: BigInt(Math.floor(reach.now() / 1000)),
        });
        const round = rounds.find((x) => x.id === named);
        if (round === undefined) throw new StepRefused(payrollWhy('not-a-run', { says: 'the company holds no payroll proposal by that name that this wallet can open' }));
        if (round.asset.toLowerCase() !== shown.asset.toLowerCase() || (round.form ?? 'shielded') !== shown.form) {
          throw new StepRefused(payrollWhy('not-as-shown', { says: 'it pays in another currency or form' }));
        }
        const { run } = await keptRunHere(records, r.accountId, round.runId, r.companyKeys);
        const leg = legOf(run, legChoiceOf({ asset: round.asset, form: round.form ?? 'shielded' }), registry);
        const part = partOf(run, leg, { proposal: named });
        if (typeof part === 'string') throw new StepRefused(payrollWhy('not-as-shown', { says: part }));
        const differs = runNotAsShown(run, part, shown);
        if (differs !== null) throw new StepRefused(payrollWhy('not-as-shown', { says: differs }));
        const vault = await proposalsVaultHere(r, records, pure, named, round.chainId);
        if (vault !== shown.vault.toLowerCase() || (part.vault !== undefined && vault !== part.vault.toLowerCase())) {
          throw new StepRefused(payrollWhy('not-as-shown', { says: 'the proposal pays from another vault than its run names' }));
        }
        vaultOf.set(named, vault);
        return { id: named, chainId: round.chainId };
      } catch (e) {
        if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
        throw new StepRefused(payrollWhy('not-a-run', { says: said(e) }));
      }
    },
    needed: (round, held, intent) => {
      const vault = vaultOf.get(intent.fields['proposal'] ?? '');
      return vault === undefined ? null : oneOffNeeded(round, held, vault);
    },
    approve: async (ctx, r, _intent, round, handed) => {
      const records = companyRecordsFor(r, reach, await pureCircuits());
      try {
        const served = theRoundAsked(await governedCallServiceFor(r.api).standing(round.id), round.id, round.chainId);
        await approveOnDevice(governedDoorsFor(ctx, r, reach, records, handed), withCompanyKeys({ round: { ...served, id: round.id, chainId: round.chainId } }, r.companyKeys));
      } catch (e) {
        if (e instanceof ApprovalNotOwed || e instanceof StepRefused || e instanceof ActionStopped) throw e;
        throw new StepRefused(payrollWhy(!handed.over || nothingWasSentBy(e) ? 'not-approved' : 'may-be-sent', { says: said(e) }));
      }
    },
    stateAt: (atItsBar, approvedNow) => (atItsBar ? 'ready-to-pay' : approvedNow ? 'approved' : null),
    why: payrollWhy,
  };
}

/**
 * **THE VAULT A PAYROLL PROPOSAL PAYS FROM, AS ITS OWN RECORD NAMES IT**, opened on this device with every check a
 * raise has (`openTheRoundHere`), and refused unless its identity on the chain is the one that vault, its payload
 * and its salt make: the chain pays from this vault, whatever the run's record says.
 */
async function proposalsVaultHere(r: CompanyReach, records: CompanyRecordsInTheWallet, pure: PureCircuits, proposal: string, chainId: string): Promise<string> {
  const opened = await openTheRoundHere(governedCallServiceFor(r.api), r.accountId, proposal, r.companyKeys, false, records, r.judges.leavesFor(r.account));
  const made = toHex(pure.account.proposalIdOf(fromHex(opened.digest as Hex), fromHex(opened.vault as Hex), fromHex(opened.salt as Hex))).toLowerCase();
  if (opened.chainId.toLowerCase() !== chainId.toLowerCase() || made !== chainId.toLowerCase()) {
    throw new StepRefused(payrollWhy('not-as-shown', { says: 'its identity on the chain is not the one its vault, payload and salt make' }));
  }
  return opened.vault.toLowerCase();
}

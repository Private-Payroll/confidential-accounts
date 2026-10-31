import type { ActIntent } from 'midnight-identity/profile/request';
import { NETWORK } from 'midnight-identity/network';
import { assets as theAssets, formatAmount, type AssetId, type AssetRegistry } from '../../../../src/core/assets.js';
import { canonicalPeriod } from '../../../../src/core/calendar-days.js';
import { EMPLOYEE_CLASSIFICATIONS, type EmployeeClassification } from '../../../../src/core/invitation.js';
import type { PersonChange } from '../../../../src/core/person-record.js';
import type { SealedProposal, SealedRun } from '../../../../src/core/types.js';
import type { VendorTerms } from '../../../../src/core/vendor-record.js';
import type { NetworkName } from '../../../../src/midnight/network.js';
import { governedCallServiceFor } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { InvitationRefused } from '../../../../packages/web-shared/src/invitation-on-device.js';
import { changePersonHere, PersonNotChanged, setStatusHere, type PeopleDevice } from '../../../../packages/web-shared/src/people-on-device.js';
import { changeVendorHere, VendorNotChanged, type VendorChange } from '../../../../packages/web-shared/src/vendors-on-device.js';
import { periodsPastDraftHere, type RoundIdentity } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import { FiledNotEntered } from '../../../../packages/web-shared/src/record-entered-here.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, keptReach, type CompanyChain, type CompanyReach } from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';
import { enteredUntilTaken, peopleDeviceFor, personNamedHere, upkeepThenEntered, type HeldUntilEntered } from './admit-person.js';
import { enteredFor } from './company-reach.js';

/*
 * CHANGING AN EMPLOYEE'S OR A VENDOR'S RECORD, IN THE WALLET. The wallet finds the person as this device believes them,
 * holds the name, kind and currency the page showed to their record, and files the next version signed by its own
 * seat. Every change is checked against the months a run has already been raised for, read from the company's runs and
 * proposals as this device believes them, so a month already raised is never paid differently. One act changes a
 * person's status or their details, never both, because the service files the two as different changes.
 */

/** What the change action reads the company with: the wallet's own chain, builder and clock, and the account's run identity. */
export interface ChangePersonReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  readonly now: () => number;
  /** The account's pure circuits that name a run's proposal, from the compiled contract this wallet ships. */
  readonly roundIdentity: () => Promise<RoundIdentity>;
  readonly network?: NetworkName;
  readonly assets?: AssetRegistry;
  /** Stands in for the wallet's own read of the company, in tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.change-person.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const HEX64 = /^[0-9a-f]{64}$/u;
const PERSON_FIELDS = ['payAmount', 'asset', 'payFrom', 'classification', 'classificationFrom', 'endDate', 'leavingDate', 'status'] as const;
const VENDOR_FIELDS = ['terms', 'termsAsset', 'termsAmount', 'endDate', 'status'] as const;

type Asked =
  | { readonly kind: 'employee'; readonly status: { readonly to: 'active' | 'leaver'; readonly leavingDate?: string } | null; readonly change: PersonChange; readonly asset: string | null }
  | { readonly kind: 'vendor'; readonly change: VendorChange };

/**
 * What the page asks changed, read from its fields, or the words of why it is refused: a field of the other kind, a
 * date both given and cleared, a person's status asked with their details, an amount of nothing, or no change at all.
 */
export function changeAskedOf(intent: ActIntent, registry: AssetRegistry = theAssets): Asked | Words {
  const f = intent.fields;
  const given = (k: string): boolean => f[k] !== undefined;
  const kind = f['kind'];
  if ((kind !== 'employee' && kind !== 'vendor') || (f['person'] ?? '') === '' || (f['personName'] ?? '') === '') return why('not-a-person');
  const allowed: readonly string[] = kind === 'employee' ? PERSON_FIELDS : VENDOR_FIELDS;
  const clear = given('clear') ? f['clear']!.split(',').map((c) => c.trim()) : [];
  const clearable = kind === 'employee' ? ['endDate', 'leavingDate'] : ['endDate'];
  if (clear.some((c) => !clearable.includes(c))) return why('not-for-this-kind');
  const others = [...PERSON_FIELDS, ...VENDOR_FIELDS].filter((k) => !allowed.includes(k) && given(k));
  if (others.length > 0) return why('not-for-this-kind');
  if (clear.some((c) => given(c))) return why('cleared-and-given');
  const status = f['status'];
  if (status !== undefined && status !== 'active' && status !== 'leaver') return why('not-a-status');
  if (kind === 'vendor') {
    let terms: VendorTerms | undefined;
    if (f['terms'] === 'one-off') terms = { kind: 'one-off' };
    else if (f['terms'] === 'monthly') {
      const asset = f['termsAsset'];
      if (asset === undefined || !HEX64.test(asset) || registry.find(asset as AssetId) === null) return why('not-an-asset');
      if (f['termsAmount'] === undefined || BigInt(f['termsAmount']) <= 0n) return why('no-pay');
      terms = { kind: 'monthly', asset: asset as AssetId, amount: BigInt(f['termsAmount']) };
    } else if (given('terms') || given('termsAsset') || given('termsAmount')) return why('not-terms');
    const change: VendorChange = {
      ...(terms === undefined ? {} : { terms }),
      ...(given('endDate') ? { endDate: f['endDate']! } : clear.includes('endDate') ? { endDate: null } : {}),
      ...(status === undefined ? {} : { status }),
    };
    return Object.keys(change).length === 0 ? why('nothing') : { kind, change };
  }
  const details = ['payAmount', 'asset', 'payFrom', 'classification', 'classificationFrom', 'endDate'].some(given) || clear.length > 0
    || (given('leavingDate') && status === undefined);
  if (status !== undefined && (details || (status === 'active' && given('leavingDate')))) return why('status-and-details');
  if (status !== undefined) {
    return { kind, status: { to: status, ...(given('leavingDate') ? { leavingDate: f['leavingDate']! } : {}) }, change: {}, asset: null };
  }
  let change: PersonChange = {};
  if (given('payAmount') || given('asset') || given('payFrom')) {
    if (!given('payAmount') || !given('asset') || !given('payFrom')) return why('pay-incomplete');
    if (BigInt(f['payAmount']!) <= 0n) return why('no-pay');
    change = { ...change, pay: { amount: BigInt(f['payAmount']!), from: f['payFrom']! } };
  }
  if (given('classification') || given('classificationFrom')) {
    const c = f['classification'] as EmployeeClassification | undefined;
    if (c === undefined || !EMPLOYEE_CLASSIFICATIONS.includes(c) || !given('classificationFrom')) return why('no-classification');
    change = { ...change, classification: { classification: c, from: f['classificationFrom']! } };
  }
  for (const k of ['endDate', 'leavingDate'] as const) {
    if (given(k)) change = { ...change, [k]: f[k]! };
    else if (clear.includes(k)) change = { ...change, [k]: null };
  }
  return Object.keys(change).length === 0 ? why('nothing') : { kind, status: null, change, asset: f['asset'] ?? null };
}

/** The action that changes, with this wallet's seat, an employee's or a vendor's record. */
export function changePersonAction(reach: ChangePersonReach): ActionDefinition {
  const network = reach.network ?? (NETWORK as NetworkName);
  const registry = reach.assets ?? theAssets;
  const refuse = (key: string): never => { throw new StepRefused(why(key)); };
  return Object.freeze({
    headline: 'act.change-person.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => {
      const f = intent.fields;
      const page = (key: string, values: Readonly<Record<string, string>>): ShownLine => ({ key: `act.change-person.shown.${key}`, values, from: 'page' });
      const clear = f['clear'] === undefined ? [] : f['clear'].split(',').map((c) => c.trim());
      const amountLine = (key: string, amount: string | undefined, code: string | undefined, more: Readonly<Record<string, string>>): ShownLine => {
        const asset = code === undefined || !HEX64.test(code) ? null : registry.find(code as AssetId);
        const raw = { amount: amount ?? '', asset: code ?? '', ...more };
        return asset === null || !/^[0-9]+$/u.test(raw.amount)
          ? page(`${key}-raw`, raw)
          : page(key, { ...raw, shown: formatAmount(BigInt(raw.amount), asset), symbol: asset.symbol, name: asset.name });
      };
      return [
        page('kind', { kind: f['kind'] ?? '' }),
        page('name', { name: f['personName'] ?? '' }),
        ...(f['payAmount'] === undefined ? [] : [amountLine('pay', f['payAmount'], f['asset'], { from: f['payFrom'] ?? '' })]),
        ...(f['classification'] === undefined ? [] : [page('classification', { classification: f['classification'], from: f['classificationFrom'] ?? '' })]),
        ...(['endDate', 'leavingDate'] as const).flatMap((k) => [
          ...(f[k] === undefined ? [] : [page(k === 'endDate' ? 'end-date' : 'leaving-date', { day: f[k]! })]),
          ...(clear.includes(k) ? [page(k === 'endDate' ? 'end-date-cleared' : 'leaving-date-cleared', {})] : []),
        ]),
        ...(f['terms'] === undefined ? [] : [f['terms'] === 'monthly'
          ? amountLine('terms-monthly', f['termsAmount'], f['termsAsset'], {})
          : page('terms', { terms: f['terms'] })]),
        ...(f['status'] === undefined ? [] : [page('status', { status: f['status'] })]),
        { key: 'act.change-person.shown.raised', from: 'action' },
        { key: 'act.change-person.shown.filed', from: 'action' },
        ...upkeepShown(),
        { key: 'act.change-person.shown.nothing-else', from: 'action' },
      ];
    },
    checks: [
      { key: 'act.change-person.check.seat' },
      { key: 'act.change-person.check.record' },
      { key: 'act.change-person.check.raised' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => {
      const asked = changeAskedOf(intent, registry);
      return 'key' in asked ? asked : null;
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.change-person.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      let held: HeldUntilEntered | null = null;
      const change: ActionStep = {
        title: { key: 'act.change-person.step.change' },
        run: async (ctx) => {
          const asked = changeAskedOf(intent, registry);
          if ('key' in asked) throw new StepRefused(asked);
          const r = await read.at(ctx);
          const entries = enteredUntilTaken(enteredFor(r));
          const d = await peopleDeviceFor(ctx, r, network, registry, refuse, entries.entered);
          const pastDraft = pastDraftFor(r, d, reach, asked.kind === 'employee' ? 'employees' : 'vendors');
          try {
            const found = await personNamedHere(d, asked.kind, intent.fields['person']!, refuse);
            const rec = found.kind === 'employee' ? found.here.person : found.here.vendor;
            if (rec.name !== intent.fields['personName']) refuse('not-as-shown');
            const first = firstDayNotRaised(await pastDraft());
            if (first !== null) {
              if (asked.kind === 'vendor' && asked.change.terms !== undefined) refuse('terms-raised');
              const was = rec as { readonly endDate?: string | null; readonly leavingDate?: string | null };
              for (const [day, before] of stopsAsked(asked, was)) {
                if ((day !== null && day < first) || (before !== null && before < first)) refuse('date-raised');
              }
            }
            if (found.kind === 'employee' && asked.kind === 'employee') {
              if (asked.asset !== null && asked.asset.toLowerCase() !== String(found.here.person.asset).toLowerCase()) refuse('not-as-shown');
              if (asked.status !== null) {
                await setStatusHere(d, found.here, asked.status.to, asked.status.to === 'leaver'
                  ? { ...(asked.status.leavingDate === undefined ? {} : { leavingDate: asked.status.leavingDate }), pastDraft }
                  : undefined);
              } else {
                await changePersonHere(d, found.here, asked.change, pastDraft);
              }
            } else if (found.kind === 'vendor' && asked.kind === 'vendor') {
              await changeVendorHere(d, found.here, asked.change, pastDraft);
            }
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            if (e instanceof FiledNotEntered) throw new StepRefused(why('filed-not-entered', { says: said(e) }));
            if (e instanceof PersonNotChanged || e instanceof VendorNotChanged) throw new StepRefused(why('not-changed', { says: said(e) }));
            if (e instanceof InvitationRefused) throw new StepRefused(why('not-filed', { says: said(e) }));
            throw new StepRefused(why('not-changed', { says: said(e) }));
          }
          read.renew();
          if (entries.waiting()) {
            held = { entries, state: 'changed' };
            return;
          }
          ctx.tell({ state: 'changed' });
        },
      };
      const last: ActionStep = {
        ...upkeep.last,
        run: (ctx) => upkeepThenEntered(ctx, upkeep.last, held, (anchored, says) => (anchored
          ? why('filed-not-entered', { says }) : why('filed-not-entered-nor-anchored', { says }))),
      };
      return [upkeep.first, seat, change, last];
    },
  } satisfies ActionDefinition);
}

/**
 * The first day of the month after the newest month a run has been raised for, or null when none has. Every day before
 * it belongs to a month whose run was drawn from the records as they stood, so a change reaching it would make the
 * raised run differ from the records, and every device would then refuse that run.
 */
function firstDayNotRaised(raised: readonly string[]): string | null {
  const latest = raised.map(canonicalPeriod).sort().at(-1);
  if (latest === undefined) return null;
  const [y, m] = latest.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/**
 * Each stop date the change sets or takes off, with the value the record holds now: an end date, a leaving date, and
 * the leaving date a leaver is made on. A date the change leaves alone is not listed.
 */
function stopsAsked(
  asked: Asked, was: { readonly endDate?: string | null; readonly leavingDate?: string | null },
): (readonly [string | null, string | null])[] {
  const out: (readonly [string | null, string | null])[] = [];
  const set: { readonly endDate?: string | null; readonly leavingDate?: string | null } = asked.kind === 'vendor'
    ? (asked.change.endDate === undefined ? {} : { endDate: asked.change.endDate })
    : asked.status !== null
      ? (asked.status.leavingDate === undefined ? {} : { leavingDate: asked.status.leavingDate })
      : asked.change;
  for (const k of ['endDate', 'leavingDate'] as const) {
    const day = set[k];
    if (day !== undefined) out.push([day, was[k] ?? null]);
  }
  return out;
}

/**
 * The months a run has already been raised for, on the list of runs the person is paid on: the company's runs and its
 * live payroll proposals, each believed only as a seat this device believes filed it, read through the wallet.
 */
function pastDraftFor(
  r: CompanyReach, d: PeopleDevice, reach: ChangePersonReach, list: 'employees' | 'vendors',
): () => Promise<readonly string[]> {
  return async () => periodsPastDraftHere({
    runs: async () => r.api(`/api/accounts/${encodeURIComponent(r.accountId)}/runs`) as Promise<readonly SealedRun[]>,
    proposals: async () => governedCallServiceFor(r.api).sealedProposals!(r.accountId) as Promise<readonly SealedProposal[]>,
    roundsOnChain: (chainIds) => r.builder.roundsOnChain({ account: r.account, indexer: r.chain.indexer, chainIds }),
    directory: d.directory,
    roundIdentity: await reach.roundIdentity(),
  }, r.accountId, r.companyKeys, new Date(reach.now()), list);
}

/**
 * **AN APPROVED PAYROLL RUN PAID FROM THE COMPANY'S VAULT, IN THE WALLET, IN ONE WINDOW.**
 *
 * The run's proposal is opened and checked by the payroll kind (`payrollKind`, raise-run.ts): it must pay exactly the
 * list, month, people, total and vault the window showed, from the vault the proposal itself names. Where it stands is
 * read from the chain through this wallet's own indexer, and nothing is sent unless it is open and at its bar (the
 * vault's approvals and the removals since it was raised, as the account counts them) and now is inside its window.
 * Then the leg, or the retry, is paid by the one payment path (`payAnApprovedLeg`, leg-paid-here.ts): charged to the
 * vault's period when the vault has a spending policy, then one payout or merge per planned step in private money, or
 * one public payout per person in public money. Everything it reads is this wallet's: the company's sealed records
 * through the one records door (`companyRecordsFor`), the account's record of payments and where the proposal stands
 * from the chain; the service only relays what is sent.
 *
 * Nobody is paid twice: the account refuses a second payment of anyone it records paid, the leg pays only who the
 * chain does not yet show paid, and a step still on its way is waited for. A stop part way says how many were paid,
 * and paying the run again pays only the people still owed. This action approves nothing: a run is approved through
 * `approve-proposal`, and paid here once it has its approvals.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { assets as theAssets } from '../../../../src/core/assets.js';
import type { Hex } from '../../../../src/core/crypto.js';
import { legChoiceOf, legOf } from '../../../../src/core/run-legs.js';
import { notEnoughApprovalsYet, nothingWasSentBy, withCompanyKeys } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { LegNotPayable, LegStopped, payAnApprovedLeg, type LegDoors, type LegPaid } from '../../../../packages/web-shared/src/leg-paid-here.js';
import { legToPayHere, type PaymentsHereDeps } from '../../../../packages/web-shared/src/payments-made-here.js';
import { ChargeNotYetSeen, RunNotChargedHere } from '../../../../packages/web-shared/src/run-charged-here.js';
import { keptRunHere, payrollRoundsHere, proposalsListedHere } from '../../../../packages/web-shared/src/run-rebuilt-here.js';
import {
  PaymentLandedUnrecorded, PaymentNotAsBuilt, PaymentNotYetSeen, PaymentStillInFlight, PublicPaymentNotYetSeen,
} from '../../../../packages/web-shared/src/vault-operation.js';
import { VAULT_KEYS_FOLDER } from '../chain/key-material.js';
import {
  companyReachFor, companyRecordsFor, keptReach, paidAmongFor, pureCircuits, type CompanyReach, type Handed,
} from './company-reach.js';
import { StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { payDoorsFor } from './one-off-payment.js';
import { atTheBar, onTheChain, type ReadCompany } from './proposal-kinds.js';
import { payrollKind, runShownLines, runShownOf, type RaiseRunReach } from './raise-run.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';

/** What paying a run is done with: what raising one is, and whether this wallet can prove a merge of the vault's notes. */
export type PayRunReach = RaiseRunReach & {
  /** Whether this wallet holds the key a merge is proved with; read from its own pinned keys unless given. */
  readonly mergesProvedHere?: () => Promise<boolean>;
};

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.pay-run.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\.\s*$/u, '');

/** Where paying the run got to, as the page is told it. */
export const PAY_RUN_STATE = {
  awaitingApprovals: 'awaiting-approvals', paid: 'paid', partlyPaid: 'partly-paid', alreadyPaid: 'already-paid',
} as const;

/** Whether the run was charged to its vault's period here. */
export const PAY_RUN_CHARGE = { charged: 'charged', none: 'none' } as const;

/**
 * **WHETHER THIS WALLET HOLDS THE KEY A MERGE IS PROVED WITH**, read from the manifest of keys it serves itself: the
 * prover and the circuit of the vault's `mergeNotes`, both pinned. A wallet whose keys were vendored before it proved
 * merges answers no, and a run whose plan merges is then refused before it is charged.
 */
export const walletHoldsTheMergeKey = async (fetchFn: typeof fetch = fetch.bind(globalThis), base = '/keys'): Promise<boolean> => {
  try {
    const response = await fetchFn(`${base}/manifest.json`);
    if (!response.ok) return false;
    const pins = (await response.json()) as { artefacts?: Record<string, unknown> };
    const held = (name: string): boolean => Object.prototype.hasOwnProperty.call(pins.artefacts ?? {}, `${VAULT_KEYS_FOLDER}/${name}`);
    return held('mergeNotes.prover') && held('mergeNotes.bzkir');
  } catch {
    return false;
  }
};

/** What the check step found, carried to the payment step. */
interface Paying {
  round: { readonly id: string; readonly chainId: string } | null;
  short: boolean;
}

/**
 * How many people the leg pays, and who it has paid, as what it did says: a payment found only by what it left counts
 * as sent, and one that may still be landing (`unseen`) is counted apart, never as owed.
 */
const countedOf = (done: LegPaid, payees: number, unseen = 0) => {
  const sent = done.paid.length + done.sentNotNamed.length;
  return { paid: sent, unseen, owed: Math.max(0, payees - done.alreadyPaid.length - sent - unseen) };
};

/** A stop after a payment was handed over that may still land: it is waited for and looked at again, never paid again at once. */
const mayStillLand = (e: unknown): boolean => e instanceof PaymentNotYetSeen || e instanceof PublicPaymentNotYetSeen
  || e instanceof PaymentStillInFlight || e instanceof PaymentLandedUnrecorded;

/**
 * Why a stop before any step was sent stopped, in the words of the step that stopped it; a stop after a step was sent
 * is a `LegStopped`, told with how many were paid.
 */
const refusalOf = (e: unknown, handed: Handed): Words => {
  if (e instanceof LegNotPayable) return why('not-payable', { says: said(e) });
  if (e instanceof ChargeNotYetSeen) return why('charge-not-seen');
  if (e instanceof RunNotChargedHere) return why('not-charged', { says: said(e) });
  if (e instanceof PaymentNotYetSeen || e instanceof PublicPaymentNotYetSeen) return why('payment-not-seen', { says: said(e) });
  if (e instanceof PaymentLandedUnrecorded) return why('payment-not-recorded', { says: said(e) });
  if (e instanceof PaymentStillInFlight) return why('payment-on-its-way', { says: said(e) });
  if (e instanceof PaymentNotAsBuilt) return why('payment-not-as-built', { says: said(e) });
  return why(!handed.over || nothingWasSentBy(e) ? 'not-paid' : 'may-be-sent', { says: said(e) });
};

/** Opens the run's proposal through the payroll kind, and reads from the chain whether it may be paid now. */
function checkStep(reach: PayRunReach, read: ReadCompany, intent: ActIntent, here: Paying): ActionStep {
  const kind = payrollKind(reach);
  return {
    title: { key: 'act.pay-run.step.check' },
    run: async (ctx) => {
      const r = await read.at(ctx);
      let named: { readonly id: string; readonly chainId: string };
      try {
        named = await kind.opened(ctx, r, intent);
      } catch (e) {
        if (e instanceof StepRefused && e.words.key.startsWith('act.approve-proposal.why.')) {
          throw new StepRefused(why(e.words.key.slice('act.approve-proposal.why.'.length), e.words.values));
        }
        throw e;
      }
      here.round = { id: named.id, chainId: named.chainId.toLowerCase() };
      const now = await onTheChain(r, here.round.chainId);
      if (now === undefined || now.held === 'never') throw new StepRefused(why('not-raised'));
      if (now.held === 'closed') throw new StepRefused(why((now.closedBy ?? []).includes('cancel') ? 'withdrawn' : 'closed'));
      const needed = kind.needed(now, await r.holders(), intent);
      ctx.tell({ approvals: now.approvals, ...(needed === null ? {} : { needed }) });
      if (!atTheBar(now, needed)) {
        here.short = true;
        ctx.tell({ state: PAY_RUN_STATE.awaitingApprovals });
      }
    },
  };
}

/** Pays the leg, or the retry, the proposal raised, through the one payment path. */
function payStep(reach: PayRunReach, read: ReadCompany, here: Paying): ActionStep {
  return {
    title: { key: 'act.pay-run.step.pay' },
    notNeeded: (told) => told['state'] === PAY_RUN_STATE.awaitingApprovals,
    run: async (ctx) => {
      if (here.round === null || here.short) return;
      const r: CompanyReach = await read.at(ctx);
      const pure = await pureCircuits();
      const records = companyRecordsFor(r, reach, pure);
      const registry = reach.assets ?? theAssets;
      const paidAmong = paidAmongFor(records, pure);
      const deps: PaymentsHereDeps = {
        detailsOf: pure.details, runPayload: pure.account.runPayload, proposalIdOf: pure.account.proposalIdOf, paidAmong,
      };
      const handed: Handed = { over: false };
      const named = here.round.id;
      try {
        const round = payrollRoundsHere(await proposalsListedHere(records), r.accountId, r.companyKeys, {
          identity: records.roundIdentity, nowInSeconds: BigInt(Math.floor(reach.now() / 1000)),
        }).find((x) => x.id === named);
        if (round === undefined) throw new StepRefused(why('not-a-run', { says: 'the company holds no payroll proposal by that name that this wallet can open' }));
        const which = { asset: round.asset, form: round.form ?? 'shielded' } as const;
        const { run } = await keptRunHere(records, r.accountId, round.runId, r.companyKeys);
        const leg = legOf(run, legChoiceOf(which), registry);
        const retry = run.proposalIds?.[leg] === named ? undefined : named;
        const { order } = await legToPayHere(records, r.accountId, round.runId, r.companyKeys, deps, which, retry);
        const nowS = BigInt(Math.floor(reach.now() / 1000));
        if (nowS < BigInt(order.opensAt)) {
          throw new StepRefused(why('not-open-yet', { opensAt: new Date(Number(order.opensAt) * 1000).toISOString() }));
        }
        if (nowS >= BigInt(order.closesAt)) throw new StepRefused(why('window-closed'));
        if (order.payments.every((p) => p.paid === true)) {
          ctx.tell({ state: PAY_RUN_STATE.alreadyPaid, paid: 0, owed: 0, charge: PAY_RUN_CHARGE.none });
          return;
        }
        const pay = payDoorsFor(ctx, r, reach, handed);
        const doors: LegDoors = {
          ...pay,
          paidYet: async (payment) => (await paidAmong([payment.leaf as Hex])).paid.length === 1,
          mergesProvedHere: reach.mergesProvedHere ?? (() => walletHoldsTheMergeKey()),
        };
        const done = await payAnApprovedLeg(doors, withCompanyKeys({
          records, accountId: r.accountId, runId: round.runId, deps, which, ...(retry === undefined ? {} : { retry }),
        }, r.companyKeys));
        const counted = countedOf(done, order.payments.length);
        ctx.tell({
          state: counted.owed === 0 ? PAY_RUN_STATE.paid : PAY_RUN_STATE.partlyPaid, ...counted,
          charge: done.steps.some((s) => s.kind === 'charge') ? PAY_RUN_CHARGE.charged : PAY_RUN_CHARGE.none,
        });
      } catch (e) {
        if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
        if (e instanceof LegStopped) {
          const landing = mayStillLand(e.cause);
          const counted = countedOf(e.done, e.done.payees, landing ? 1 : 0);
          ctx.tell({
            state: PAY_RUN_STATE.partlyPaid, ...counted,
            charge: e.done.steps.some((s) => s.kind === 'charge') ? PAY_RUN_CHARGE.charged : PAY_RUN_CHARGE.none,
          });
          throw new StepRefused(why(landing ? 'stopped-unseen' : 'stopped', { paid: counted.paid, payees: e.done.payees, says: said(e.cause) }));
        }
        if (!handed.over && notEnoughApprovalsYet(e)) {
          ctx.tell({ state: PAY_RUN_STATE.awaitingApprovals });
          return;
        }
        throw new StepRefused(refusalOf(e, handed));
      }
    },
  };
}

/** The `pay-run` action: one window, one passkey, for an approved run's leg or retry. */
export function payRunAction(reach: PayRunReach): ActionDefinition {
  const registry = reach.assets ?? theAssets;
  return Object.freeze({
    headline: 'act.pay-run.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      { key: 'act.pay-run.shown.proposal', values: { proposal: intent.fields['proposal'] ?? '' }, from: 'page' as const },
      ...runShownLines(intent, registry, 'act.pay-run.shown'),
      { key: 'act.pay-run.shown.matched', from: 'action' as const },
      { key: 'act.pay-run.shown.pay', from: 'action' as const },
      { key: (await (reach.mergesProvedHere ?? (() => walletHoldsTheMergeKey()))()) ? 'act.pay-run.shown.merge' : 'act.pay-run.shown.no-merge', from: 'action' as const },
      { key: 'act.pay-run.shown.again', from: 'action' as const },
      ...upkeepShown(),
      { key: 'act.pay-run.shown.nothing-else', from: 'action' as const },
    ],
    checks: [
      { key: 'act.pay-run.check.seat' },
      { key: 'act.pay-run.check.run' },
      { key: 'act.pay-run.check.chain' },
      { key: 'act.pay-run.check.window' },
      UPKEEP_CHECK,
    ],
    check: async (intent) => {
      if (intent.fields['record'] === undefined) return why('not-a-company');
      if ((intent.fields['proposal'] ?? '') === '') return why('not-a-run', { says: 'it names no proposal to pay' });
      const shown = runShownOf(intent);
      return 'key' in shown ? why('not-a-run', shown.values) : null;
    },
    steps: (intent) => {
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const here: Paying = { round: null, short: false };
      const seat: ActionStep = {
        title: { key: 'act.pay-run.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      return [seat, upkeep.first, checkStep(reach, read, intent, here), payStep(reach, read, here), upkeep.last];
    },
  } satisfies ActionDefinition);
}

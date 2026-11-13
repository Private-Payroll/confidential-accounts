/**
 * **A VAULT'S SPENDING POLICY, AND THE APPROVALS ANY POLICY CHANGE NEEDS, AS KINDS OF THE ONE APPROVAL.** Another
 * seat raised the change; this wallet approves it with the person's seat and carries it out once the chain counts its
 * bar. A policy's terms are this wallet's own reading, never the page's: the page names the vault, and this wallet opens
 * the policy the proposal commits to from a version of its sealed record this seat believes, finds its currency by the
 * key the proposal commits to, shows the terms in its window for the person to confirm before anything is sent, and
 * approves exactly those. A bar is the page's number, approved only when the record the proposal opens to names the
 * same. Where each stands, and the bar it is carried out at, are read from the chain through the person's own wallet.
 * Every check is made by the shared code before each send: the policy in force and the one proposed open here, its
 * highest band leaves every vault enough signers who may approve its runs, no signer on their way out filed it.
 * Approving files nothing.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { assets as theAssets, formatAmount, type Asset, type AssetId, type AssetRegistry } from '../../../../src/core/assets.js';
import type { GovernanceOnTheWire } from '../../../../packages/web-shared/src/governed-call-builder.js';
import {
  ApprovalNotOwed, nothingWasSentBy, seatsUnderARaisedRemovalHere, WithdrawnWhileSent, withCompanyKeys, type GovernedOutcome,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { openTheRoundHere } from '../../../../packages/web-shared/src/round-opened-here.js';
import {
  approveSpendingPolicyOnDevice, PolicyNotOpenedHere, policyReadHere, setPolicyBarOnDevice, type PolicyGovernanceDoors, type PolicyRead, type PolicySteps,
} from '../../../../packages/web-shared/src/spending-policy-here.js';
import { vaultInfoHere, vaultInfoRecordsFor, type VaultInfoRead } from '../../../../packages/web-shared/src/vault-info-here.js';
import { governanceDoorsFor, type CompanyReach, type Handed } from './company-reach.js';
import { policiesInTheWallet } from './policy-doors-in-the-wallet.js';
import { codeOfError, StepRefused, type ShownLine, type StepContext, type Words } from './definition.js';
import { carryStep, type ApprovalStop, type CarryOut, type ProposalKind, type RoundHere } from './proposal-kinds.js';
import { ActionStopped } from './run.js';

/** What approving a policy or its bar needs beyond the company: how to wait between reads of the chain. */
export interface PolicyKindsReach {
  readonly pause: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly waitMs?: number;
  readonly everyMs?: number;
  /** The currencies this wallet knows, which a policy's amounts are shown in; the product's own unless given. */
  readonly assets?: AssetRegistry;
}

/** Where a policy or a bar stands once this wallet's approval is counted. */
export const POLICY_STATE = { waiting: 'waiting-for-approvals', atItsBar: 'ready-to-carry' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.approve-policy.why.${key}`, ...(values === undefined ? {} : { values }),
});
const KIND_WHY: Readonly<Record<string, string>> = { closed: 'carried-out', counted: 'already-counted' };
const kindWhy = (stop: ApprovalStop | string, values?: Readonly<Record<string, string | number>>): Words => why(KIND_WHY[stop] ?? stop, values);
const said = (e: unknown): string => String((e as Error)?.message ?? e);
const WHOLE = /^[1-9][0-9]{0,8}$/u;
const DIGITS = /^[0-9]{1,39}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
/* The latest moment a date can name, in milliseconds. */
const MOST_MS = 8_640_000_000_000_000n;
const DAY = 86_400n;

/**
 * A moment named in seconds, as the wallet shows a date and time elsewhere, with its year, in UTC and saying so: a
 * policy's period starts at a moment on the chain, the same everywhere, so it is never shown in the device's own zone.
 */
const momentOf = (seconds: string): string => new Date(Number(seconds) * 1000).toLocaleString(undefined, {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
});

/** A period's length in days, to two places, from its seconds. */
const daysOf = (seconds: string): string => {
  const hundredths = (BigInt(seconds) * 100n) / DAY;
  const whole = (hundredths / 100n).toString();
  const rest = (hundredths % 100n).toString().padStart(2, '0');
  return rest === '00' ? whole : `${whole}.${rest}`;
};

/**
 * The vault's name as the company's records hold it, opened in this wallet with the company's keys and judged as every
 * record it reads is. Never a refusal: a vault with no name filed, or one this wallet cannot read, is shown by its
 * address alone with a line saying which.
 */
export const vaultNameHere = async (r: CompanyReach, vault: string): Promise<VaultInfoRead> => {
  try {
    const judge = r.judges.filingJudgeFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
    return await vaultInfoHere({ companyKeys: r.companyKeys, records: vaultInfoRecordsFor(r.accountId, null, judge, () => null, r.send) }, vault);
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    return { state: 'unread', why: said(e), version: null };
  }
};

/** The line naming the vault and currency a policy is for: by the vault's name beside its address where the records name it. */
export const policyVaultShown = (vault: string, token: string, named: VaultInfoRead): Words[] => (named.state === 'named'
  ? [{ key: 'act.approve-policy.shown.policy-named', values: { name: named.name, vault, token } }]
  : [{ key: 'act.approve-policy.shown.policy', values: { vault, token } },
    { key: named.state === 'none' ? 'act.approve-policy.shown.vault-unnamed' : 'act.approve-policy.shown.vault-name-unread' }]);

/**
 * The lines a policy's terms are shown in, in the currency's own units, or a refusal when they cannot be shown: other
 * than four bands, a number that is not whole, or a first period no date can name.
 */
export const termsShown = (t: PolicyRead['opening']['terms'], asset: Asset): Words[] => {
  const numbers = [t.periodLimit, t.periodStart, t.periodLength, ...t.bands.flatMap((b) => [b.ceiling, b.approvals])].map(String);
  if (t.bands.length !== 4 || !numbers.every((x) => DIGITS.test(x)) || BigInt(t.periodStart) * 1000n > MOST_MS) {
    throw new StepRefused(why('cannot-show'));
  }
  const limit = formatAmount(BigInt(t.periodLimit), asset);
  return [
    ...t.bands.map((b, i): Words => ({
      key: 'act.approve-policy.shown.band', values: { n: i + 1, ceiling: formatAmount(BigInt(b.ceiling), asset), symbol: asset.symbol, approvals: String(b.approvals) },
    })),
    {
      key: 'act.approve-policy.shown.limit',
      values: { limit, symbol: asset.symbol, name: asset.name, start: momentOf(String(t.periodStart)), days: daysOf(String(t.periodLength)) },
    },
    /* Said beside the limit: carrying the change out starts the running period's total again, whatever was paid in it. */
    { key: 'act.approve-policy.shown.period-starts-again', values: { limit, symbol: asset.symbol } },
    { key: 'act.approve-policy.shown.confirm-period-starts-again' },
    { key: 'act.approve-policy.shown.raises-the-seat-bar', values: { approvals: String(Math.max(...t.bands.map((b) => Number(b.approvals)))) } },
  ];
};

/** The lines this wallet shows of the policy it read, for the person to confirm: the vault and currency, then its terms. */
const readShown = (read: PolicyRead, asset: Asset, vault: string, named: VaultInfoRead): Words[] =>
  [...policyVaultShown(vault, asset.symbol, named), ...termsShown(read.opening.terms, asset)];

/** What the first step read of a policy, as the approval and the carrying out are handed it; refused when nothing was read. */
const policyReadOf = (round: RoundHere): PolicyRead => {
  const read = round.read as PolicyRead | undefined;
  if (read === undefined || typeof read.asset !== 'string' || typeof read.chainId !== 'string' || read.chainId !== round.chainId) {
    throw new StepRefused(why('not-read'));
  }
  return read;
};

/**
 * The doors the shared code takes a policy change through: the governance doors of every change to the company, with
 * the company's spending policies read, and filed only with `files` (`policiesInTheWallet`), and the seats under a
 * raised removal read from the company's proposals, refusing when they cannot be read in full.
 */
export const policyDoorsFor = (
  r: CompanyReach, reach: Pick<PolicyKindsReach, 'pause' | 'waitMs' | 'everyMs'>, ctx: StepContext, handed: Handed, o: { readonly files?: true } = {},
): PolicyGovernanceDoors => {
  const doors = governanceDoorsFor(r, (ms) => reach.pause(ms, ctx.signal), handed, {
    ...(reach.waitMs === undefined ? {} : { waitMs: reach.waitMs }), ...(reach.everyMs === undefined ? {} : { everyMs: reach.everyMs }),
  });
  return {
    ...doors,
    records: { ...doors.records!, spendingPolicies: policiesInTheWallet(r, o) },
    builder: r.builder,
    leaving: () => seatsUnderARaisedRemovalHere(doors, r.companyKeys, true),
  };
};

/** A refusal of the shared code's, or one that stopped after something was handed over to be sent, in this kind's words. */
const stoppedAs = (e: unknown, handed: Handed, notSent: string): never => {
  if (e instanceof StepRefused || e instanceof ActionStopped || e instanceof ApprovalNotOwed || e instanceof WithdrawnWhileSent) throw e;
  if (e instanceof PolicyNotOpenedHere) throw new StepRefused(why('refused', { says: said(e) }), codeOfError(e));
  throw new StepRefused(why(!handed.over || nothingWasSentBy(e) ? notSent : 'may-be-sent', { says: said(e) }), codeOfError(e));
};

/** The carrying out at the bar: the shared code, asked only to carry out, answers done or nothing was sent. */
const carriedOr = (out: GovernedOutcome): void => {
  if (out.state !== 'done') {
    throw Object.assign(new Error('the company\'s records do not show this proposal at the approvals it needs yet, so it was not carried out.'), { nothingWasSent: true });
  }
};

/**
 * **ONE VAULT'S SPENDING POLICY FOR ONE CURRENCY.** The page names the vault, and may name a currency only to narrow
 * where this wallet looks. The first step reads the rest with the seat's keys (`policyReadHere`): the currency, by the
 * key the proposal commits to among those this wallet knows, and the terms, from a version of the policy's sealed
 * record this seat believes. It shows them in the window as it read them and goes on only on the person's Confirm. The
 * approval and the carrying out are handed exactly that reading, and the shared code opens the proposal again before
 * each send and refuses it unless it still sets those terms. Judged at the seat bar, the higher of the account's
 * threshold and the approvals a policy change needs, which is what `setPolicy` asks for when it is carried out, and the
 * bar the proposal was raised with.
 */
export function spendingPolicyKind(reach: PolicyKindsReach): ProposalKind {
  const registry = reach.assets ?? theAssets;
  const vaultOf = (intent: ActIntent): string => (intent.fields['vault'] ?? '').toLowerCase();
  const onDevice = (ctx: StepContext, r: CompanyReach, intent: ActIntent, handed: Handed, round: RoundHere, steps: PolicySteps & { readonly approveOnly: string }) => {
    const read = policyReadOf(round);
    return approveSpendingPolicyOnDevice(policyDoorsFor(r, reach, ctx, handed), withCompanyKeys({
      proposal: intent.fields['proposal']!, vault: vaultOf(intent), asset: read.asset, terms: read.opening.terms, ...steps,
    }, r.companyKeys));
  };
  const carryOut: CarryOut = async (ctx, r, intent, round, handed) => {
    carriedOr(await onDevice(ctx, r, intent, handed, round, { approveOnly: round.chainId, carryOnly: true }));
  };
  const kind: ProposalKind = {
    fields: ['vault'],
    changesTheCompany: true,
    readsFirst: true,
    shown: async (intent): Promise<readonly ShownLine[]> => [
      { key: 'act.approve-policy.shown.proposal', values: { proposal: intent.fields['proposal'] ?? '' }, from: 'page' },
      { key: 'act.approve-policy.shown.policy-vault', values: { vault: intent.fields['vault'] ?? '' }, from: 'page' },
      { key: 'act.approve-policy.shown.read-here', from: 'action' },
      { key: 'act.approve-policy.shown.checks', from: 'action' },
      { key: 'act.approve-policy.shown.approve', from: 'action' },
    ],
    check: (intent) => {
      if (!HEX64.test(intent.fields['vault'] ?? '')) return why('not-a-policy');
      const token = intent.fields['token'];
      return token !== undefined && registry.find(token as AssetId) === null ? why('not-a-known-currency') : null;
    },
    opened: async (ctx, r, intent) => {
      const token = intent.fields['token'];
      const among = token === undefined ? registry.all().map((a) => a.code) : [token as AssetId];
      let read: PolicyRead;
      try {
        read = await policyReadHere(policyDoorsFor(r, reach, ctx, { over: false }), withCompanyKeys({
          proposal: intent.fields['proposal']!, vault: vaultOf(intent), among,
        }, r.companyKeys));
      } catch (e) {
        if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
        throw new StepRefused(why('not-approved', { says: said(e) }), codeOfError(e));
      }
      const asset = registry.find(read.asset);
      if (asset === null) throw new StepRefused(why('not-a-known-currency'));
      const chainId = read.chainId.toLowerCase();
      return { id: intent.fields['proposal']!, chainId, read: { ...read, chainId }, confirm: readShown(read, asset, vaultOf(intent), await vaultNameHere(r, vaultOf(intent))) };
    },
    needed: (round, held) => Math.max(round.needed ?? 0, held.seatBar),
    approve: async (ctx, r, intent, round, handed) => {
      try {
        await onDevice(ctx, r, intent, handed, round, { approveOnly: round.chainId, stopBeforeCarry: true });
      } catch (e) {
        stoppedAs(e, handed, 'not-approved');
      }
    },
    stateAt: (atItsBar) => (atItsBar ? POLICY_STATE.atItsBar : POLICY_STATE.waiting),
    carry: (here, read, intent) => [carryStep(kind, intent, read, here, { key: 'act.approve-policy.step.carry' }, carryOut)],
    why: kindWhy,
  };
  return kind;
}

/** Why a bar is refused before anything is built, from the seats the chain holds now: the contract's own bounds. */
const barRefusal = (bar: number, seats: number): string | null => (bar > seats
  ? `a change to a spending policy cannot need more approvals than the ${seats} signers the company has seated. Withdraw this proposal, `
    + 'or seat more signers first. Nothing was sent.'
  : null);

/**
 * A bar handed to the shared code, refused first while it is more than the seats the chain holds, and checked against
 * the seats again before every send: raised, approved or carried out as `steps` say.
 */
export const policyBarOnDevice = async (
  reach: Pick<PolicyKindsReach, 'pause' | 'waitMs' | 'everyMs'>, ctx: StepContext, r: CompanyReach, bar: number, handed: Handed, steps: PolicySteps,
): Promise<GovernedOutcome> => {
  const seated = async (): Promise<number> => (await r.holders()).seats.length;
  const no = barRefusal(bar, await seated());
  if (no !== null) throw new StepRefused(why('refused', { says: no }));
  return setPolicyBarOnDevice(policyDoorsFor(r, reach, ctx, handed), withCompanyKeys({
    newBar: bar, seated: await seated(), ...steps,
    before: async () => {
      const again = barRefusal(bar, await seated());
      if (again !== null) throw new PolicyNotOpenedHere(again.replace(/ Nothing was sent\.$/u, ''));
    },
  }, r.companyKeys));
};

/**
 * **THE APPROVALS ANY CHANGE TO A SPENDING POLICY NEEDS.** Opened from the proposal and refused unless it sets the
 * number shown; refused while that number is more than the seats the chain holds, which `setPolicyBar` refuses when it
 * is carried out, checked again before every send. Judged at the seat bar, which `setPolicyBar` asks for.
 */
export function policyBarKind(reach: PolicyKindsReach): ProposalKind {
  const barOf = (intent: ActIntent): number => {
    const f = intent.fields['bar'] ?? '';
    if (!WHOLE.test(f)) throw new StepRefused(why('not-a-bar'));
    return Number(f);
  };
  const onDevice = (ctx: StepContext, r: CompanyReach, intent: ActIntent, handed: Handed, steps: PolicySteps & { readonly approveOnly: string }) =>
    policyBarOnDevice(reach, ctx, r, barOf(intent), handed, steps);
  const carryOut: CarryOut = async (ctx, r, intent, round, handed) => {
    carriedOr(await onDevice(ctx, r, intent, handed, { approveOnly: round.chainId, carryOnly: true }));
  };
  const kind: ProposalKind = {
    fields: ['bar'],
    changesTheCompany: true,
    shown: async (intent): Promise<readonly ShownLine[]> => [
      { key: 'act.approve-policy.shown.proposal', values: { proposal: intent.fields['proposal'] ?? '' }, from: 'page' },
      { key: 'act.approve-policy.shown.bar', values: { bar: intent.fields['bar'] ?? '' }, from: 'page' },
      /* The bar is every signer's choice to make, and the window warns of what it costs (one lost key). */
      { key: 'act.approve-policy.shown.bar-every-signer', values: { bar: intent.fields['bar'] ?? '' }, from: 'action' },
      { key: 'act.approve-policy.shown.bar-below-a-band', from: 'action' },
      { key: 'act.approve-policy.shown.checks-bar', from: 'action' },
      { key: 'act.approve-policy.shown.approve', from: 'action' },
    ],
    check: (intent) => (WHOLE.test(intent.fields['bar'] ?? '') ? null : why('not-a-bar')),
    opened: async (ctx, r, intent) => {
      const bar = barOf(intent);
      const doors = policyDoorsFor(r, reach, ctx, { over: false });
      let governance: GovernanceOnTheWire | undefined;
      let chainId: string;
      try {
        const opened = await openTheRoundHere(doors.service, r.accountId, intent.fields['proposal']!, r.companyKeys, false, doors.records, doors.leaves, false,
          'set-policy-bar');
        governance = opened.governance as GovernanceOnTheWire | undefined;
        chainId = opened.chainId;
      } catch (e) {
        if (e instanceof ActionStopped) throw e;
        throw new StepRefused(why('not-approved', { says: said(e) }), codeOfError(e));
      }
      if (governance?.kind !== 'policy-bar' || String(governance.bar) !== String(bar)) throw new StepRefused(why('not-as-shown'));
      return { id: intent.fields['proposal']!, chainId };
    },
    needed: (round, held) => Math.max(round.needed ?? 0, held.seatBar),
    approve: async (ctx, r, intent, round, handed) => {
      try {
        await onDevice(ctx, r, intent, handed, { approveOnly: round.chainId, stopBeforeCarry: true });
      } catch (e) {
        stoppedAs(e, handed, 'not-approved');
      }
    },
    stateAt: (atItsBar) => (atItsBar ? POLICY_STATE.atItsBar : POLICY_STATE.waiting),
    carry: (here, read, intent) => [carryStep(kind, intent, read, here, { key: 'act.approve-policy.step.carry' }, carryOut)],
    why: kindWhy,
  };
  return kind;
}

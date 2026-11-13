/**
 * **A VAULT'S SPENDING POLICY, AND THE APPROVALS ANY POLICY CHANGE NEEDS, RAISED FROM THE PERSON'S OWN WALLET.** The
 * page names the change; this wallet checks it, raises it as a proposal with the person's seat, and carries it out once
 * the chain counts the approvals it needs, reading the chain before it says so. A spending policy is filed first as a
 * version of the policy's sealed record, signed by this seat, and your wallet will not file or raise one from a seat
 * whose role does not set spending policies, or for a vault the company's account on the chain has not adopted. A new
 * bar may be raised by any seat, as any proposal may. Every check the shared code makes is made again before each send:
 * the policy in force opens here, the vault keeps enough signers who may approve its runs, no signer on their way out
 * set it, and the bar is no more than the seats the chain holds.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { assets as theAssets, type Asset, type AssetId, type AssetRegistry } from '../../../../src/core/assets.js';
import { signingPublicKeyOf, type Hex } from '../../../../src/core/crypto.js';
import {
  POLICY_BANDS, policyTermsFromWire, policyTermsToWire, SPENDING_POLICY_KIND, type PolicyOpeningOnTheWire,
} from '../../../../src/midnight/spending-policy-record.js';
import { nothingWasSentBy, withCompanyKeys, type GovernedOutcome } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { mayFileHere } from '../../../../packages/web-shared/src/may-file-here.js';
import { PolicyNotOpenedHere, setSpendingPolicyOnDevice } from '../../../../packages/web-shared/src/spending-policy-here.js';
import { companyReachFor, keptReach, type CompanyChain, type CompanyReach, type Handed } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { policyBarKind, policyBarOnDevice, policyDoorsFor, spendingPolicyKind, termsShown, type PolicyKindsReach } from './policy-kinds.js';
import { approving, onTheChain, type ProposalKind } from './proposal-kinds.js';
import { ActionStopped } from './run.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';

/** What the two acts need of the wallet beyond the company: the chain, the worker, a pause between reads, the currencies it knows. */
export interface SetPolicyReach extends PolicyKindsReach {
  readonly chain: () => CompanyChain;
  readonly builder: () => VaultBuilderClient;
  /** Stands in for reading the company in a test; the wallet reads it from the saved keys. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
}

/** The two acts, named as the proposals they raise are sealed. */
export type SetPolicyAct = 'set-spending-policy' | 'set-policy-bar';

/** Where the change stands once raised: waiting for approvals, or at its bar for this wallet to carry out. */
export const SET_POLICY_STATE = { waiting: 'waiting-for-approvals', atItsBar: 'ready-to-carry' } as const;

const said = (e: unknown): string => String((e as Error)?.message ?? e);
const HEX64 = /^[0-9a-f]{64}$/u;
const WHOLE = /^[1-9][0-9]{0,8}$/u;
const BAND = /^([0-9]{1,39}):([1-9][0-9]{0,8})$/u;
const whyOf = (act: SetPolicyAct) => (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.${act}.why.${key}`, ...(values === undefined ? {} : { values }),
});

/** A spending policy as the page asks it: the vault, its currency, and four bands written `ceiling:approvals`, checked as the contract takes them. */
interface PolicyAsked { readonly vault: string; readonly asset: Asset; readonly terms: PolicyOpeningOnTheWire['terms'] }

export const policyAskedOf = (intent: ActIntent, registry: AssetRegistry): PolicyAsked | Words => {
  const f = intent.fields;
  const why = whyOf('set-spending-policy');
  const vault = (f['vault'] ?? '').toLowerCase();
  const asset = registry.find((f['token'] ?? '') as AssetId);
  if (asset === null) return why('not-a-known-currency');
  const bands = (f['bands'] ?? '').split(',').map((b) => BAND.exec(b));
  if (!HEX64.test(vault) || bands.length !== POLICY_BANDS || bands.some((m) => m === null)) return why('not-a-policy');
  try {
    const terms = policyTermsToWire(policyTermsFromWire({
      bands: bands.map((m) => ({ ceiling: m![1]!, approvals: m![2]! })),
      periodLimit: f['periodLimit'], periodStart: f['periodStart'], periodLength: f['periodLength'],
    }));
    termsShown(terms, asset);
    return { vault, asset, terms };
  } catch (e) {
    if (e instanceof PolicyNotOpenedHere || e instanceof StepRefused) return why('not-a-policy');
    throw e;
  }
};

const barAskedOf = (intent: ActIntent): number | Words =>
  (WHOLE.test(intent.fields['bar'] ?? '') ? Number(intent.fields['bar']) : whyOf('set-policy-bar')('not-a-bar'));

/**
 * Refuses a spending policy from a seat whose role does not set spending policies, or one the company's directory, as
 * this wallet reads it, does not hold or believe. Run first, before anything is filed, and its words say nothing was
 * filed or sent; run again before each send (`after`), once the policy's record may already be filed and, where
 * something was handed over, the proposal may already stand raised with this seat's approval, and its words say so.
 */
const mayRaiseAPolicyHere = async (r: CompanyReach, after?: Handed): Promise<void> => {
  const directory = r.judges.directoryHereFor(r.accountId, r.label, r.account, r.companyKeys, r.roster);
  const no = await mayFileHere(directory, signingPublicKeyOf(r.seat.signingSecret as Hex), SPENDING_POLICY_KIND);
  if (no === null) return;
  const why = whyOf('set-spending-policy');
  if (after !== undefined) throw new StepRefused(why(after.over ? 'may-not-set-after-sending' : 'may-not-set-after-filing'));
  throw new StepRefused(why(no.why === 'role' ? 'may-not-set' : no.why === 'no-seat' ? 'seat-not-in-directory' : 'seat-not-believed'));
};

/**
 * Refuses a spending policy for a vault the company's account on the chain has not adopted, as this wallet reads the
 * account: the chain would never carry it out. Nothing is filed or raised.
 */
const refuseAVaultNotAdopted = async (r: CompanyReach, vault: string): Promise<void> => {
  const adopted = (await r.holders()).adoptedVaults.some((v) => v.toLowerCase() === vault);
  if (!adopted) throw new StepRefused(whyOf('set-spending-policy')('not-adopted', { vault }));
};

/** A refusal of the shared code's, or one that stopped after something was handed over to be sent, in this act's words. */
const stoppedAs = (e: unknown, handed: Handed, why: ReturnType<typeof whyOf>): never => {
  if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
  if (e instanceof PolicyNotOpenedHere) throw new StepRefused(why('refused', { says: said(e) }), codeOfError(e));
  throw new StepRefused(why(!handed.over || nothingWasSentBy(e) ? 'not-raised' : 'may-be-sent', { says: said(e) }), codeOfError(e));
};

/** The raise itself, through the shared code, stopped before the carrying out; a policy is filed as this seat's version first. */
const raisedHere = async (act: SetPolicyAct, reach: SetPolicyReach, ctx: StepContext, r: CompanyReach, intent: ActIntent, handed: Handed): Promise<GovernedOutcome> => {
  const why = whyOf(act);
  if (act === 'set-policy-bar') {
    const bar = barAskedOf(intent) as number;
    const seats = (await r.holders()).seats.length;
    if (bar > seats) throw new StepRefused(why('too-many', { bar, seats }));
    return policyBarOnDevice(reach, ctx, r, bar, handed, { stopBeforeCarry: true });
  }
  const a = policyAskedOf(intent, reach.assets ?? theAssets) as PolicyAsked;
  await mayRaiseAPolicyHere(r);
  await refuseAVaultNotAdopted(r, a.vault);
  return setSpendingPolicyOnDevice(policyDoorsFor(r, reach, ctx, handed, { files: true }), withCompanyKeys({
    vault: a.vault, asset: a.asset.code, terms: a.terms, stopBeforeCarry: true, before: () => mayRaiseAPolicyHere(r, handed),
  }, r.companyKeys));
};

/**
 * **ONE CHANGE OF POLICY, RAISED.** Steps: read the company and the seat, the owed upkeep, check and raise, carry out
 * once the chain counts the approvals, and the anchor. The carrying out is the approval's own (`spendingPolicyKind`,
 * `policyBarKind`): a spending policy is read back from the company's records after it is raised, and carried out with
 * exactly the terms read, at the seat bar the chain asks for.
 */
export function setPolicyAction(reach: SetPolicyReach, act: SetPolicyAct): ActionDefinition {
  const why = whyOf(act);
  const asked = (intent: ActIntent): Words | null => {
    const a = act === 'set-policy-bar' ? barAskedOf(intent) : policyAskedOf(intent, reach.assets ?? theAssets);
    return typeof a === 'object' && 'key' in a ? a : null;
  };
  return Object.freeze({
    headline: `act.${act}.headline`,
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      ...shownAsked(act, intent, reach.assets ?? theAssets),
      { key: `act.${act}.shown.checks`, from: 'action' as const },
      { key: `act.${act}.shown.raise`, from: 'action' as const },
      { key: `act.${act}.shown.public`, from: 'action' as const },
      ...upkeepShown(),
      { key: `act.${act}.shown.nothing-else`, from: 'action' as const },
    ],
    checks: [{ key: `act.${act}.check.seat` }, { key: `act.${act}.check.change` }, UPKEEP_CHECK],
    check: async (intent) => ((intent.fields['record'] ?? '') === '' ? why('not-a-company') : asked(intent)),
    steps: (intent) => {
      const kind: ProposalKind = act === 'set-policy-bar' ? policyBarKind(reach) : spendingPolicyKind(reach);
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const here = approving();
      let filed: ActIntent = intent;
      const seat: ActionStep = { title: { key: `act.${act}.step.seat` }, run: async (ctx) => { await read.at(ctx); } };
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const raise: ActionStep = {
        title: { key: `act.${act}.step.raise` },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const no = asked(intent);
          if (no !== null) throw new StepRefused(no);
          const handed: Handed = { over: false };
          let out: GovernedOutcome;
          try {
            out = await raisedHere(act, reach, ctx, r, intent, handed);
          } catch (e) {
            return stoppedAs(e, handed, why);
          }
          if (out.round === null) throw new StepRefused(why('not-raised', { says: 'The company holds no record of the proposal raised. Nothing more was sent.' }));
          filed = { ...intent, fields: { ...intent.fields, proposal: out.round.id } } as ActIntent;
          here.round = { id: out.round.id, chainId: String(out.round.chainId).toLowerCase() };
          if (act === 'set-spending-policy') here.round = { ...here.round, read: await readBack(ctx, kind, r, filed, why) };
          const now = await onTheChain(r, here.round.chainId);
          here.standing = now ?? null;
          here.needed = now === undefined ? null : kind.needed(now, await r.holders(), filed);
          ctx.tell({
            state: out.state === 'ready-to-carry' ? SET_POLICY_STATE.atItsBar : SET_POLICY_STATE.waiting, proposal: out.round.id,
            ...(now === undefined ? {} : { approvals: now.approvals }), ...(here.needed === null ? {} : { needed: here.needed }),
          });
        },
      };
      const carry: ActionStep = {
        title: { key: `act.${act}.step.carry` },
        run: async (ctx) => { if (here.round !== null) await kind.carry!(here, read, filed)[0]!.run(ctx); },
      };
      return [seat, upkeep.first, raise, carry, upkeep.last];
    },
  } satisfies ActionDefinition);
}

/** The policy just raised, read back from the company's records with this seat's keys, as an approval reads it. */
async function readBack(ctx: StepContext, kind: ProposalKind, r: CompanyReach, filed: ActIntent, why: ReturnType<typeof whyOf>): Promise<unknown> {
  try {
    return (await kind.opened(ctx, r, filed)).read;
  } catch (e) {
    if (e instanceof ActionStopped) throw e;
    throw new StepRefused(why('raised-not-read', { proposal: filed.fields['proposal'] ?? '' }), codeOfError(e));
  }
}

/** What the page asks, as this wallet shows it before the passkey: the change and its terms in the currency's own units. */
function shownAsked(act: SetPolicyAct, intent: ActIntent, registry: AssetRegistry): ShownLine[] {
  if (act === 'set-policy-bar') {
    const bar = intent.fields['bar'] ?? '';
    return [
      { key: 'act.approve-policy.shown.bar', values: { bar }, from: 'page' },
      { key: 'act.approve-policy.shown.bar-every-signer', values: { bar }, from: 'action' },
      { key: 'act.approve-policy.shown.bar-below-a-band', from: 'action' },
    ];
  }
  const a = policyAskedOf(intent, registry);
  if ('key' in a) return [{ key: 'act.set-spending-policy.shown.not-a-policy', from: 'page' }];
  return [
    { key: 'act.set-spending-policy.shown.policy', values: { vault: a.vault, token: a.asset.symbol }, from: 'page' },
    ...termsShown(a.terms, a.asset).map((l): ShownLine => ({ ...l, from: 'page' })),
  ];
}

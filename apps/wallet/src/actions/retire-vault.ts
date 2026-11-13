/**
 * **A VAULT RETIRED FROM THE PERSON'S OWN WALLET**: the retire raised with this seat's approval counted, carried out by
 * the vault itself once the chain holds it at the company's threshold, and the same retire approved and carried from
 * the proposals list. The wallet refuses before raising or carrying while the chain it reads shows the vault holding
 * any money, or while this wallet keeps a deposit into it or a payment out of it on its way. Money paid into a vault
 * after it is retired waits there until the company adopts the vault again.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { readVaultAddress } from 'midnight-identity/profile/company-label';
import type { Hex } from '../../../../src/core/crypto.js';
import { ApprovalNotOwed, governedCallServiceFor, nothingWasSentBy } from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { browserDepositsInFlight, browserPaymentsInFlight } from '../../../../packages/web-shared/src/in-flight-in-this-browser.js';
import type { InFlightOpener } from '../../../../packages/web-shared/src/in-flight-on-this-device.js';
import {
  approveRetireHere, carryRetireHere, RetireRefused, retireFoundHere, retireRaisedHere, type RetireDoors, type RetireNamed,
} from '../../../../packages/web-shared/src/vault-retire-round.js';
import { VaultStartOwed } from '../../../../packages/web-shared/src/vault-start-stops.js';
import type { VaultBuilderClient } from '../../../../packages/web-shared/src/vault-worker-client.js';
import { companyReachFor, handOverMarked, keptReach, type CompanyReach, type Handed } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { approving, carryStep, type ApprovalStop, type CarryOut, type ProposalKind } from './proposal-kinds.js';
import { ActionStopped } from './run.js';
import type { StartKindsReach } from './start-kinds.js';
import { UPKEEP_CHECK, upkeepShown, upkeepSteps } from './upkeep.js';
import { vaultDoorsFor } from './vault-doors-here.js';
import { VAULT_CIRCUITS_THE_WALLET_PROVES } from '../chain/account-circuits.js';

export interface RetireVaultReach extends StartKindsReach {
  readonly builder: () => VaultBuilderClient;
  /** Stands in for reading the company and this seat, for the tests. */
  readonly reachFor?: (ctx: StepContext) => Promise<CompanyReach>;
  /**
   * Where this wallet keeps a deposit and a payment on their way, which a retire refuses while either waits for the
   * vault; its own storage unless given. Named apart from a payment's `kept`, because the one approval hands every
   * kind the same reach.
   */
  readonly inFlight?: (opener: InFlightOpener) => NonNullable<RetireDoors['inFlight']>;
}

/** What the page is told the retire got to. */
export const RETIRE_STATE = { waiting: 'waiting-for-approvals', atItsBar: 'ready-to-carry', carried: 'carried-out' } as const;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.retire-vault.why.${key}`, ...(values === undefined ? {} : { values }),
});
const KIND_WHY: Readonly<Record<string, string>> = { closed: 'carried-out', counted: 'already-counted' };
const kindWhy = (stop: ApprovalStop | string, values?: Readonly<Record<string, string | number>>): Words => why(KIND_WHY[stop] ?? stop, values);
const vaultOf = (intent: ActIntent): Hex | null => {
  const v = readVaultAddress(intent.fields['vault']);
  return v === null ? null : String(v).toLowerCase() as Hex;
};
const namedOf = (intent: ActIntent): RetireNamed => ({ vault: vaultOf(intent)!, proposal: intent.fields['proposal']! });

/** This wallet's own storage for a deposit and a payment on their way: this origin's, which no page can reach. */
const keptInTheWallet = (opener: InFlightOpener): NonNullable<RetireDoors['inFlight']> => ({
  deposits: browserDepositsInFlight(opener), payments: browserPaymentsInFlight(opener),
});

/**
 * The doors a retire acts through, each marking `handed` once it hands a call over. A call taking a token off the
 * vault's list is not the retire: it is counted in `handed.before`, never marking the retire handed over. `proves`
 * answers from the vault circuits this wallet holds proving keys for.
 */
export function retireDoorsFor(ctx: StepContext, r: CompanyReach, reach: RetireVaultReach, handed: Handed): RetireDoors {
  if (reach.indexerHttp === undefined) {
    throw new StepRefused(why('not-raised', { says: 'This wallet does not know the indexer it reads a vault at. Nothing was sent.' }));
  }
  const d = vaultDoorsFor(ctx, r, { secrets: reach.secrets, pause: reach.pause, indexerHttp: reach.indexerHttp });
  const service = governedCallServiceFor(r.api);
  return {
    ...d,
    handOver: handOverMarked(d.handOver, handed, (call) => call.kind === 'vault-forget'),
    proves: (circuit) => VAULT_CIRCUITS_THE_WALLET_PROVES.includes(circuit),
    approveSent: (id, body) => { handed.over = true; return service.approve(id, body); },
    ...(service.closed === undefined ? {} : { closedSent: service.closed.bind(service) }),
    inFlight: (reach.inFlight ?? keptInTheWallet)(d.me),
  };
}

/**
 * A refusal from the retire's own steps, or a stop, as the page is told it. Every line places `says` at the start of a
 * sentence, so it starts in capitals; after a hand-over the line itself says to press again, so `says` does not again.
 */
const stoppedAs = (e: unknown, handed: Handed, notSent: string): never => {
  if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
  const words = e instanceof VaultStartOwed ? e.why : String((e as Error)?.message ?? e);
  const sent = !(!handed.over || nothingWasSentBy(e) || e instanceof RetireRefused);
  const said = sent ? words.replace(/\s*Press again\b.*$/su, '') : words;
  const says = said.charAt(0).toUpperCase() + said.slice(1);
  throw new StepRefused(why(sent ? 'may-be-sent' : notSent, { says }), codeOfError(e));
};

/** What every retire shows first, whether it is raised or approved: the vault, what is checked, and what goes ahead of it. */
const retireShown = (intent: ActIntent): readonly ShownLine[] => [
  { key: 'act.retire-vault.shown.vault', values: { vault: intent.fields['vault'] ?? '' }, from: 'page' },
  { key: 'act.retire-vault.shown.checks', from: 'action' },
  { key: 'act.retire-vault.shown.forget', from: 'action' },
];

/**
 * **A VAULT'S RETIRE AS A KIND OF THE ONE APPROVAL**: opened from the company's records under the name the page gave
 * and made again from its vault and salt, approved by any seat whose role may change the company, and carried out by
 * the vault itself once at the company's threshold.
 */
export function retireVaultKind(reach: RetireVaultReach): ProposalKind {
  const carryOut: CarryOut = (ctx, r, intent, _round, handed) => carryRetireOnce(ctx, r, namedOf(intent), handed, reach);
  const kind: ProposalKind = {
    fields: ['vault'],
    changesTheCompany: true,
    shown: async (intent): Promise<readonly ShownLine[]> => [...retireShown(intent), { key: 'act.retire-vault.shown.approve', from: 'action' }],
    check: (intent) => (vaultOf(intent) === null ? why('not-a-vault') : null),
    opened: async (ctx, r, intent) => {
      const handed: Handed = { over: false };
      try {
        const found = await retireFoundHere(retireDoorsFor(ctx, r, reach, handed), namedOf(intent));
        return { id: found.rec.id, chainId: found.round.chainId };
      } catch (e) {
        return stoppedAs(e, handed, 'not-approved');
      }
    },
    needed: (onChain, held) => Math.max(onChain.needed ?? 0, held.approvals),
    approve: async (ctx, r, intent, _round, handed) => {
      let done: Awaited<ReturnType<typeof approveRetireHere>>;
      try {
        done = await approveRetireHere(retireDoorsFor(ctx, r, reach, handed), namedOf(intent));
      } catch (e) {
        return stoppedAs(e, handed, 'not-approved');
      }
      if (done !== 'approved') throw new ApprovalNotOwed(done === 'counted' ? 'counted' : 'carried-out');
    },
    stateAt: (atItsBar) => (atItsBar ? RETIRE_STATE.atItsBar : RETIRE_STATE.waiting),
    carry: (here, read, intent) => [carryStep(kind, intent, read, here, { key: 'act.retire-vault.step.carry' }, carryOut)],
    why: kindWhy,
  };
  return kind;
}

/**
 * **THE RETIRE RAISED FROM THIS WALLET**: the vault read empty on the chain first, the retire raised with this seat's
 * approval counted, and carried out by the vault at once when that already meets the company's threshold.
 */
export function retireVaultAction(reach: RetireVaultReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.retire-vault.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      ...retireShown(intent),
      { key: 'act.retire-vault.shown.raise', from: 'action' as const },
      ...upkeepShown(),
      { key: 'act.retire-vault.shown.nothing-else', from: 'action' as const },
    ],
    checks: [{ key: 'act.retire-vault.check.empty' }, { key: 'act.retire-vault.check.seat' }, UPKEEP_CHECK],
    check: async (intent) => {
      if (intent.fields['record'] === undefined) return why('not-a-company');
      return vaultOf(intent) === null ? why('not-a-vault') : null;
    },
    steps: (intent) => {
      const kind = retireVaultKind(reach);
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const here = approving();
      const upkeep = upkeepSteps({ reach: read.at, renew: read.renew }, {});
      const raise: ActionStep = {
        title: { key: 'act.retire-vault.step.raise' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const handed: Handed = { over: false };
          let raised: Awaited<ReturnType<typeof retireRaisedHere>>;
          try {
            raised = await retireRaisedHere(retireDoorsFor(ctx, r, reach, handed), vaultOf(intent)!);
          } catch (e) {
            return stoppedAs(e, handed, 'not-raised');
          }
          if (raised.said !== null) ctx.tell({ said: 'proposal-not-written-down' });
          const { found } = raised;
          here.round = { id: found.rec.id, chainId: found.round.chainId };
          here.standing = found.onChain;
          here.needed = kind.needed(found.onChain, await r.holders(), intent);
          const atItsBar = here.needed !== null && found.onChain.approvals >= here.needed;
          ctx.tell({ state: atItsBar ? RETIRE_STATE.atItsBar : RETIRE_STATE.waiting, approvals: found.onChain.approvals, needed: here.needed ?? 0 });
        },
      };
      /* The record the raise found names the retire carried, whatever the page named. */
      const carry = carryStep(kind, intent, read, here, { key: 'act.retire-vault.step.carry' },
        (ctx, r, _intent, round, handed) => carryRetireOnce(ctx, r, { vault: vaultOf(intent)!, proposal: round.id }, handed, reach));
      return [upkeep.first, raise, carry, upkeep.last];
    },
  } satisfies ActionDefinition);
}

/** Carries the retire the company's record names out, or says it waits for approvals; the page is told which. */
async function carryRetireOnce(ctx: StepContext, r: CompanyReach, named: RetireNamed, handed: Handed, reach: RetireVaultReach): Promise<void | { readonly state: string }> {
  let out: Awaited<ReturnType<typeof carryRetireHere>>;
  try {
    out = await carryRetireHere(retireDoorsFor(ctx, r, reach, handed), named);
  } catch (e) {
    return stoppedAs(e, handed, 'not-carried');
  }
  if (out.said !== null) ctx.tell({ said: 'proposal-not-written-down' });
  return out.state === 'waiting' ? { state: RETIRE_STATE.waiting } : undefined;
}

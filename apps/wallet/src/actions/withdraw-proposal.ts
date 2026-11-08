/**
 * **A PROPOSAL WITHDRAWN FROM THE PERSON'S OWN WALLET, BEHIND ONE PASSKEY.** The page names the proposal and the kind it
 * shows; this wallet opens the proposal from the company's records, refuses a kind other than the one shown, reads from
 * the chain, with the seat it holds, where the proposal stands and who raised it, and sends the withdrawal only where the
 * chain would take it: a run before its time to be paid begins, by any signer; any other proposal by the seat that raised
 * it. Whether a run's time has begun is judged by the time of the newest block at the indexer this wallet names; the
 * withdrawal is still checked against this device's clock as it is built, so a clock ahead of the chain's is refused with
 * words saying so. A run whose time has begun is refused with words that say whether it can still be paid and whether a
 * hold can still stop it. The outcome is read from the chain, never from the service.
 *
 * What it refuses, with words that say why: adding a vault, a vault's first secret, the pay-record key, and a one-off
 * payment the chain holds. Raised again after a withdrawal, the first three would carry the same identity, and an
 * approval the chain already holds for it cannot be given again, so they could never be carried out; a one-off is open
 * for payment as soon as it is raised, so the chain takes no withdrawal of it. A one-off the chain does not hold is marked
 * withdrawn in the company's records, and told as that: a raise of it the service held could still land. A removal whose
 * leaving seat is already written down as retired is refused: carried out is the only way on. A recovery of the company's records is not withdrawn here: it has no record in the
 * company's list of proposals.
 */
import type { ActIntent } from 'midnight-identity/profile/request';
import { ADOPT_VAULT, PAY_KEY, VAULT_SECRET } from '../../../../src/core/proposal-filing.js';
import type { RoundOnChain, OpenedRound } from '../../../../packages/web-shared/src/governed-call-builder.js';
import {
  governedCallServiceFor, nothingWasSentBy, SentAndNotYetSeen, withCompanyKeys, WithdrawalRefused, withdrawOnDevice, type WithdrawalOutcome,
} from '../../../../packages/web-shared/src/governed-call-on-device.js';
import { NotOpenedOnThisDevice } from '../../../../packages/web-shared/src/round-opened-here.js';
import { chainTimeOf } from './chain-time.js';
import { companyReachFor, companyRecordsFor, keptReach, pureCircuits, type Handed } from './company-reach.js';
import { codeOfError, StepRefused, type ActionDefinition, type ActionStep, type ShownLine, type StepContext, type Words } from './definition.js';
import { governedDoorsFor, type OneOffPaymentReach } from './one-off-payment.js';
import { ActionStopped } from './run.js';

export type WithdrawProposalReach = OneOffPaymentReach;

const why = (key: string, values?: Readonly<Record<string, string | number>>): Words => ({
  key: `act.withdraw-proposal.why.${key}`, ...(values === undefined ? {} : { values }),
});
const said = (e: unknown): string => String((e as Error)?.message ?? e).replace(/\.\s*$/u, '');

/**
 * **EVERY KIND A PAGE NAMES, AND THE KIND THE PROPOSAL'S SEALED RECORD NAMES FOR IT.** A kind mapped to `never` is
 * refused before anything is opened, with its own words; every other kind is withdrawn only when the record opened names
 * exactly that kind.
 */
export const WITHDRAWN_KINDS: Readonly<Record<string, { readonly sealedAs: string } | { readonly never: string }>> = Object.freeze({
  'add-signer': { sealedAs: 'add-signer' },
  removal: { sealedAs: 'remove-signer' },
  threshold: { sealedAs: 'set-threshold' },
  'vault-threshold': { sealedAs: 'set-vault-threshold' },
  'spending-policy': { sealedAs: 'set-spending-policy' },
  'policy-bar': { sealedAs: 'set-policy-bar' },
  payroll: { sealedAs: 'payroll' },
  'one-off': { sealedAs: 'transfer' },
  'adopt-vault': { never: 'never-adopt-vault' },
  'vault-secret': { never: 'never-vault-secret' },
  'pay-key': { sealedAs: PAY_KEY },
  recovery: { never: 'never-recovery' },
});
/** Kinds sealed for a vault's set-up: whatever the page called them, never withdrawn here. */
const SEALED_NEVER: Readonly<Record<string, string>> = { [ADOPT_VAULT]: 'never-adopt-vault', [VAULT_SECRET]: 'never-vault-secret' };

const NAMED = ['record', 'proposal', 'kind'] as const;
const kindAsked = (intent: ActIntent) => {
  const k = intent.fields['kind'] ?? '';
  return Object.prototype.hasOwnProperty.call(WITHDRAWN_KINDS, k) ? WITHDRAWN_KINDS[k]! : null;
};

/**
 * The refusal of the kind opened, run inside the withdrawal before anything is built or sent: a kind of a vault's set-up
 * is never withdrawn, the kind the record names must be the one shown, a one-off the chain holds is not withdrawn, and
 * the company's pay-record key is withdrawn only once the chain shows a removal has outrun it: until then it can still be
 * carried out, and raised again it would carry the same identity, whose approvals given before cannot be given again.
 */
const kindRefusal = (shown: string) => (opened: OpenedRound, onChain: RoundOnChain): void => {
  const sealed = String(opened.kind ?? '');
  if (SEALED_NEVER[sealed] !== undefined) throw new StepRefused(why(SEALED_NEVER[sealed]!));
  if (sealed !== shown) throw new StepRefused(why('not-as-shown'));
  if (sealed === 'transfer' && onChain.held !== 'never') throw new StepRefused(why('one-off-held'));
  if (sealed === PAY_KEY && onChain.outrun !== true) throw new StepRefused(why('never-pay-key'));
};

/**
 * The action. Its outcome tells the page `state`, where the chain shows the proposal after the withdrawal
 * (`withdrawOnDevice`), and `proposal`, the one withdrawn.
 */
export function withdrawProposalAction(reach: WithdrawProposalReach): ActionDefinition {
  return Object.freeze({
    headline: 'act.withdraw-proposal.headline',
    shown: async (intent: ActIntent): Promise<readonly ShownLine[]> => [
      { key: 'act.withdraw-proposal.shown.proposal', values: { proposal: intent.fields['proposal'] ?? '' }, from: 'page' as const },
      { key: 'act.withdraw-proposal.shown.kind', values: { kind: intent.fields['kind'] ?? '' }, from: 'page' as const },
      { key: 'act.withdraw-proposal.shown.who', from: 'action' as const },
      { key: 'act.withdraw-proposal.shown.final', from: 'action' as const },
      { key: 'act.withdraw-proposal.shown.nothing-else', from: 'action' as const },
    ],
    checks: [
      { key: 'act.withdraw-proposal.check.seat' },
      { key: 'act.withdraw-proposal.check.same' },
      { key: 'act.withdraw-proposal.check.chain' },
    ],
    check: async (intent) => {
      const empty = (k: string) => intent.fields[k] === undefined || intent.fields[k] === '';
      const kind = kindAsked(intent);
      if (kind === null || NAMED.some(empty)) return why('not-a-proposal');
      return 'never' in kind ? why(kind.never) : null;
    },
    steps: (intent) => {
      const kind = kindAsked(intent);
      if (kind === null || 'never' in kind) return [];
      const read = keptReach(reach.reachFor ?? ((c: StepContext) => companyReachFor(c, reach.chain(), reach.builder(), (k) => why(k))));
      const seat: ActionStep = {
        title: { key: 'act.withdraw-proposal.step.seat' },
        run: async (ctx) => { await read.at(ctx); },
      };
      const withdraw: ActionStep = {
        title: { key: 'act.withdraw-proposal.step.withdraw' },
        run: async (ctx) => {
          const r = await read.at(ctx);
          const proposal = intent.fields['proposal']!;
          const handed: Handed = { over: false };
          /* The chain's time, from the newest block at the indexer this wallet names; a run is refused when it is not read. */
          const chainTime = chainTimeOf(r);
          let state: WithdrawalOutcome;
          try {
            const records = companyRecordsFor(r, reach, await pureCircuits());
            const doors = governedDoorsFor(ctx, r, reach, records, handed);
            const service = governedCallServiceFor(r.api);
            const done = await withdrawOnDevice({
              ...doors,
              service: {
                ...doors.service,
                /* A withdrawal carrying a proven call is handed to the chain; one without changes only the company's records. */
                cancel: (id, body) => { if (body.tx !== undefined) handed.over = true; return service.cancel!(id, body); },
              },
            }, withCompanyKeys({ round: { id: proposal }, chainTime, check: kindRefusal(kind.sealedAs) }, r.companyKeys));
            state = done.withdrawal;
          } catch (e) {
            if (e instanceof StepRefused || e instanceof ActionStopped) throw e;
            const code = codeOfError(e);
            if (e instanceof WithdrawalRefused) throw new StepRefused(why(e.why, e.until === undefined ? undefined : { until: e.until }), code);
            if (e instanceof NotOpenedOnThisDevice) throw new StepRefused(why('not-withdrawn', { says: said(e) }), code);
            if (e instanceof SentAndNotYetSeen) throw new StepRefused(why('may-be-sent', { says: said(e) }), code);
            throw new StepRefused(why(!handed.over || nothingWasSentBy(e) ? 'not-withdrawn' : 'may-be-sent', { says: said(e) }), code);
          }
          ctx.tell({ state, proposal });
        },
      };
      return [seat, withdraw];
    },
  } satisfies ActionDefinition);
}

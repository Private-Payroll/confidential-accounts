/**
 * **WHAT THE COMPANY ACCOUNT'S OWN FUNCTIONS SAY, WORKED OUT IN THE VAULT WORKER**: its company-wide value and
 * policy bar key, a spending policy's keys, a proposal's identity, a period's total, the anchor heads and seat
 * openings, and where a run's charge and the last recovery stand in a state the page handed in.
 */
import {
  anchorHeadsAfter,
  anchorTagIn,
  identityOfAChange,
  lastRecoveryIn,
  seatOpeningsIn,
  spendingPolicyKeysOf,
  vouchedRunIdentityOf
} from './governed-call-builder.js';
import { periodTotalOf, runChargeStandingOf } from './run-charge-builder.js';
import { fromBase64 } from './base64-bytes.js';
import type { VaultBuilderDeps } from './vault-builder.js';
import type { SpendingPolicyKeysAsked, SpendingPolicyKeysMade, VaultAnswer, VaultAsk } from './vault-worker-client.js';
import type { WorkerDeps } from './vault-worker-deps.js';

/** One pair's keys by the account's own functions, or why they could not be made, so one pair's refusal is never another's. */
const keysMadeOf = (d: WorkerDeps, pair: SpendingPolicyKeysAsked): SpendingPolicyKeysMade => {
  try {
    return { keys: spendingPolicyKeysOf(d, pair) };
  } catch (e) {
    return { refused: String((e as Error)?.message ?? e) };
  }
};

/** The asks the account's own functions answer; any other ask is answered elsewhere, so this gives undefined. */
export const accountReadsAnswered = async (
  d: WorkerDeps,
  _withNetwork: VaultBuilderDeps,
  ask: VaultAsk
): Promise<VaultAnswer | undefined> => {
  switch (ask.ask) {
    case 'company-wide': {
      const v = (d.accountPure as unknown as { companyWide(): Uint8Array }).companyWide();
      return {
        id: ask.id,
        ok: true,
        ask: 'company-wide',
        value: Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')
      };
    }
    case 'policy-bar-key': {
      const { policyBarKey } = d.accountPure as unknown as { policyBarKey?: () => Uint8Array };
      if (typeof policyBarKey !== 'function') {
        throw new Error(
          "this device was not given the account's function for the key its policy bar is kept under, so nothing was read."
        );
      }
      const v = policyBarKey();
      return {
        id: ask.id,
        ok: true,
        ask: 'policy-bar-key',
        value: Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')
      };
    }
    case 'spending-policy-keys':
      return { id: ask.id, ok: true, ask: 'spending-policy-keys', keys: ask.pairs.map((pair) => keysMadeOf(d, pair)) };
    case 'proposal-identity':
      return { id: ask.id, ok: true, ask: 'proposal-identity', identity: identityOfAChange(d, ask.change, ask.salt) };
    case 'vouched-run-identity':
      return { id: ask.id, ok: true, ask: 'vouched-run-identity', chainId: vouchedRunIdentityOf(d, ask.run) };
    case 'period-total':
      return {
        id: ask.id,
        ok: true,
        ask: 'period-total',
        spent: periodTotalOf(d, { accountState: fromBase64(ask.accountState), ask: ask.total }).toString()
      };
    case 'anchor-heads':
      return {
        id: ask.id,
        ok: true,
        ask: 'anchor-heads',
        ...anchorHeadsAfter(d, { after: ask.after, holders: ask.holders ?? [] })
      };
    case 'seat-openings':
      return {
        id: ask.id,
        ok: true,
        ask: 'seat-openings',
        ...seatOpeningsIn(d, {
          account: ask.account,
          openings: ask.openings,
          ...(ask.own === undefined ? {} : { own: ask.own })
        })
      };
    case 'anchor-tag':
      return { id: ask.id, ok: true, ask: 'anchor-tag', tag: anchorTagIn(d, ask.account, ask.material) };
    case 'last-recovery':
      return { id: ask.id, ok: true, ask: 'last-recovery', head: lastRecoveryIn(d, fromBase64(ask.accountState)) };
    case 'run-charged':
      return {
        id: ask.id,
        ok: true,
        ask: 'run-charged',
        standing: runChargeStandingOf(d, { accountState: fromBase64(ask.accountState), proposal: ask.proposal })
      };
    default:
      return undefined;
  }
};

/**
 * **A CALL TO THE COMPANY ACCOUNT, BUILT AND PROVED IN THE VAULT WORKER**: a governed call, a run cleared, a seat
 * an invitation took, and an anchor of the company's records, each built on the account's state at one block.
 */
import {
  buildAnchorCall,
  buildGovernedCall,
  buildRecoverAnchorCall,
  buildSeatInvitedCall,
  type InvitedSeatInput
} from './governed-call-builder.js';
import { buildClearRun } from './run-charge-builder.js';
import { fromBase64, toBase64 } from './base64-bytes.js';
import type { VaultBuilderDeps } from './vault-builder.js';
import type { VaultAnswer, VaultAsk } from './vault-worker-client.js';
import type { WorkerDeps } from './vault-worker-deps.js';

/** The asks that build a call to the account; any other ask is answered elsewhere, so this gives undefined. */
export const accountCallsAnswered = async (
  d: WorkerDeps,
  withNetwork: VaultBuilderDeps,
  ask: VaultAsk
): Promise<VaultAnswer | undefined> => {
  /* Each call is built with the settings of the network the ask names. */
  const asked = { ...d, network: withNetwork.network };
  switch (ask.ask) {
    case 'governed-call': {
      const built = await buildGovernedCall(asked, {
        account: ask.account,
        order: ask.order,
        material: ask.material,
        chain: { accountState: fromBase64(ask.chain.accountState), parameters: fromBase64(ask.chain.parameters) },
        opened: ask.opened
      });
      return { id: ask.id, ok: true, ask: 'governed-call', tx: toBase64(built.proven) };
    }
    case 'clear-run': {
      /* The charge and the period's total it is charged against are worked out from one block's state, never kept. */
      const built = await buildClearRun(asked, {
        account: ask.account,
        run: ask.run,
        runs: ask.runs,
        chain: { accountState: fromBase64(ask.chain.accountState), parameters: fromBase64(ask.chain.parameters) }
      });
      return {
        id: ask.id,
        ok: true,
        ask: 'clear-run',
        tx: built.proven === null ? null : toBase64(built.proven),
        spent: built.spent === null ? null : built.spent.toString()
      };
    }
    case 'seat-invited': {
      const built = await buildSeatInvitedCall(asked, {
        account: ask.account,
        proposal: ask.proposal,
        material: ask.material as InvitedSeatInput['material'],
        invite: ask.invite as InvitedSeatInput['invite'],
        proposalSalt: ask.proposalSalt as InvitedSeatInput['proposalSalt'],
        intoVacatedSlot: ask.intoVacatedSlot,
        newThreshold: ask.newThreshold,
        chain: { accountState: fromBase64(ask.chain.accountState), parameters: fromBase64(ask.chain.parameters) }
      });
      return { id: ask.id, ok: true, ask: 'seat-invited', tx: toBase64(built.proven) };
    }
    case 'anchor': {
      const built = await buildAnchorCall(asked, {
        account: ask.account,
        material: ask.material,
        previous: ask.previous,
        batch: ask.batch,
        held: ask.held,
        chain: { accountState: fromBase64(ask.chain.accountState), parameters: fromBase64(ask.chain.parameters) }
      });
      return { id: ask.id, ok: true, ask: 'anchor', tx: toBase64(built.proven) };
    }
    case 'recover-anchor': {
      const built = await buildRecoverAnchorCall(asked, {
        account: ask.account,
        material: ask.material,
        previous: ask.previous,
        batch: ask.batch,
        held: ask.held,
        resumesFrom: ask.resumesFrom,
        latest: ask.latest,
        lastRecovery: ask.lastRecovery,
        proposal: ask.proposal,
        proposalSalt: ask.proposalSalt,
        chain: { accountState: fromBase64(ask.chain.accountState), parameters: fromBase64(ask.chain.parameters) }
      });
      return { id: ask.id, ok: true, ask: 'recover-anchor', tx: toBase64(built.proven), placement: built.placement };
    }
    default:
      return undefined;
  }
};

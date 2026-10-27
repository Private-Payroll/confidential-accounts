import type { ActIntentName } from 'midnight-identity/profile/request';
import type { CreationLedger } from 'midnight-identity/profile/creation-sign';
import type { ActionDefinition } from './definition.js';
import { finishCompanyAction } from './finish-company.js';
import { accountBuilding } from '../chain/account-builder-client.js';
import { liveCreationChain } from '../chain/creation-chain.js';
import { liveConstruction } from '../chain/account-as-constructed.js';
import { builtAccountKeys, builtVerifierKeys } from '../chain/this-builds-account-keys.js';
import { labelInAccountState } from '../chain/company-label-on-chain.js';
import { NETWORK, INDEXER_HTTP_URL } from '../config.js';
import { giveVaultKeysAction } from './give-vault-keys.js';
import { createVaultAction } from './create-vault.js';
import { liveCompanyChain } from '../chain/company-chain.js';
import { walletVaultBuilder } from '../chain/vault-builder-client.js';
import { vaultSecretsKeptFor } from './vault-secret-kept.js';
import { privateDepositAction } from './private-deposit.js';
import { oneOffPaymentAction } from './one-off-payment.js';
import { liveBalanceDoors } from '../screens/approve-balance.js';
import { claimByAddressAction } from './claim-by-address.js';
import { seatInvitedAction } from './seat-invited.js';

/** Waits `ms`, or rejects at once when `signal` aborts first. */
export const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new Error('stopped')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', stopped); resolve(); }, ms);
  const stopped = (): void => { clearTimeout(timer); reject(new Error('stopped')); };
  signal.addEventListener('abort', stopped, { once: true });
});

/**
 * EVERY ACTION THIS WALLET RUNS, ONE DEFINITION PER ACTION A PAGE MAY NAME.
 *
 * Keyed by the same names the ask's parser accepts, and typed so that this
 * wallet does not build while an action a page may name has no definition
 * here. An ask naming an action with none is refused before anything is shown.
 */
/** What the vault actions read the chain with, build in, and keep a new vault's secret in: this wallet's own. */
const VAULTS = Object.freeze({
  chain: liveCompanyChain,
  builder: (() => { let b: ReturnType<typeof walletVaultBuilder> | null = null; return () => (b ??= walletVaultBuilder()); })(),
  now: () => Date.now(),
  secrets: (person: string) => vaultSecretsKeptFor(person),
  pause,
  indexerHttp: INDEXER_HTTP_URL,
});

export const ACTIONS: { readonly [K in ActIntentName]: ActionDefinition } = Object.freeze({
  'finish-company': finishCompanyAction({
    build: accountBuilding(),
    chain: liveCreationChain(),
    ledger: async () => (await import('@midnightntwrk/ledger-v9')) as unknown as CreationLedger,
    construction: liveConstruction,
    built: builtAccountKeys,
    verifiers: builtVerifierKeys,
    network: NETWORK,
    labelIn: labelInAccountState,
    pause,
    now: () => Date.now(),
    timeToLive: async (tx) => {
      const [{ newestTimeToLive }, ledger, { base64 }] = await Promise.all([
        import('../../../../packages/web-shared/src/vault-builder.js'),
        import('@midnightntwrk/ledger-v9'),
        import('@scure/base'),
      ]);
      return newestTimeToLive({ ledger: ledger as never }, [base64.decode(tx)]);
    },
  }),
  'give-vault-keys': giveVaultKeysAction(VAULTS),
  'create-vault': createVaultAction(VAULTS),
  'private-deposit': privateDepositAction({ ...VAULTS, balance: liveBalanceDoors }),
  'one-off-payment': oneOffPaymentAction(VAULTS),
  'claim-by-address': claimByAddressAction({ network: NETWORK }),
  'seat-invited': seatInvitedAction({
    chain: VAULTS.chain, builder: VAULTS.builder, network: NETWORK,
    commitments: async () => (await import('../../../../src/midnight/commitments.js')).MidnightCommitments as never,
  }),
});

/** The definition of the action with this name, or `null` when this wallet runs none by that name. */
export function actionFor(name: string): ActionDefinition | null {
  const all = ACTIONS as Readonly<Record<string, ActionDefinition>>;
  return Object.prototype.hasOwnProperty.call(all, name) ? all[name] ?? null : null;
}

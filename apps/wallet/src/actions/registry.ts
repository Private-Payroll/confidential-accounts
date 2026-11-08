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
import type { Identity } from 'midnight-identity/keys/derivation';
import type { CompanyChain } from './company-reach.js';
import { walletVaultBuilder } from '../chain/vault-builder-client.js';
import { vaultSecretsKeptFor } from './vault-secret-kept.js';
import { privateDepositAction } from './private-deposit.js';
import { oneOffPaymentAction } from './one-off-payment.js';
import { liveBalanceDoors } from '../screens/approve-balance.js';
import { claimByAddressAction } from './claim-by-address.js';
import { joinByCodeAction } from './join-by-code.js';
import { seatInvitedAction } from './seat-invited.js';
import { inviteAction } from './invite.js';
import { approveProposalAction } from './approve-proposal.js';
import { changeThresholdAction } from './change-threshold.js';
import { removeSignerAction } from './remove-signer.js';
import type { RemoveSignerReach } from './remove-signer.js';
import { rotationDoorsIn } from './upkeep.js';
import type { VaultDoorsReach } from './vault-doors-here.js';
import { toldOf, vaultSecretsChangedHere } from './vault-secrets-changed-here.js';
import { rotateVaultSecretsAction } from './rotate-vault-secrets.js';
import { admitSignerAction } from './admit-signer.js';
import { admitPersonAction } from './admit-person.js';
import { changePersonAction } from './change-person.js';
import { chooseCompanyServiceAction } from './choose-company-service.js';
import { raiseRunAction } from './raise-run.js';
import { payRunAction } from './pay-run.js';
import { withdrawProposalAction } from './withdraw-proposal.js';
import { ownWalletFrom, recoveryAction, type RecoveryReach } from './recovery.js';
import { landedOnTheChain } from '../chain/pending.js';
import { treeKeptHere } from '../../../../packages/web-shared/src/tree-kept-here.js';
import type { RoundIdentity } from '../../../../packages/web-shared/src/run-rebuilt-here.js';

/** Waits `ms`, or rejects at once when `signal` aborts first. */
export const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new Error('stopped')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', stopped); resolve(); }, ms);
  const stopped = (): void => { clearTimeout(timer); reject(new Error('stopped')); };
  signal.addEventListener('abort', stopped, { once: true });
});

/**
 * **WHAT RUNS ONCE THE CHAIN HAS CARRIED A REMOVAL OUT**, for the removal action and the one approval alike
 * (`AfterRemovalCarried`, remove-signer.ts): every vault's secret is changed from this wallet so the signer who left
 * cannot open what comes next (`vaultSecretsChangedHere`, as a person's press: it raises a new secret's run and carries
 * it when the approvals are met). The wallet of the seat that left makes nothing. It is handed the company as read again
 * after the company key's change, and answers how many vaults ended in each state.
 */
export const afterARemoval = (reach: VaultDoorsReach): Pick<RemoveSignerReach, 'afterCarried'> => Object.freeze({
  afterCarried: async (ctx, r, removed) =>
    toldOf(await vaultSecretsChangedHere(ctx, r, reach, await rotationDoorsIn(r, r.api), 'raise', { leaf: removed.leaf })),
});

/**
 * The person's own wallet for an account, as a call sent straight to the chain pays its fee with it, and its own read
 * of whether a call is already on the chain.
 */
const ownWallet = (identity: Identity, account: number) => ({ ...ownWalletFrom(liveBalanceDoors(identity, account)), landed: landedOnTheChain() });

/** The chain every action reads, with the person's own wallet for a call the act sends straight to it. */
const companyChain = (): CompanyChain => Object.freeze({ ...liveCompanyChain(), ownWallet });

/** What the vault actions read the chain with, build in, and keep a new vault's secret in: this wallet's own. */
const VAULTS = Object.freeze({
  chain: companyChain,
  builder: (() => { let b: ReturnType<typeof walletVaultBuilder> | null = null; return () => (b ??= walletVaultBuilder()); })(),
  now: () => Date.now(),
  secrets: (person: string) => vaultSecretsKeptFor(person),
  pause,
  indexerHttp: INDEXER_HTTP_URL,
});

/**
 * A recovery's reach: the chain and the builder every action reads, the heads this device kept, and the person's own
 * wallet to pay each call's fee - never the company's service.
 */
const RECOVERY: RecoveryReach = Object.freeze<RecoveryReach>({
  chain: VAULTS.chain, builder: VAULTS.builder, now: VAULTS.now, pause,
  kept: () => treeKeptHere(),
  ownWallet,
});

/**
 * EVERY ACTION THIS WALLET RUNS, ONE DEFINITION PER ACTION A PAGE MAY NAME.
 *
 * Keyed by the same names the ask's parser accepts, and typed so that this
 * wallet does not build while an action a page may name has no definition
 * here. An ask naming an action with none is refused before anything is shown.
 */
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
  'join-by-code': joinByCodeAction({ network: NETWORK }),
  'seat-invited': seatInvitedAction({
    chain: VAULTS.chain, builder: VAULTS.builder, network: NETWORK,
    commitments: async () => (await import('../../../../src/midnight/commitments.js')).MidnightCommitments as never,
    payKeyWrapKeyOf: async () => ((await import('../../../../contracts/managed/contract/index.js')) as unknown as {
      pureCircuits: { payKeyWrapKeyOf(account: Uint8Array, sk: Uint8Array, part: bigint): Uint8Array };
    }).pureCircuits.payKeyWrapKeyOf,
  }),
  invite: inviteAction({
    chain: VAULTS.chain, builder: VAULTS.builder, now: VAULTS.now, pause, network: NETWORK as never,
    commitments: async () => (await import('../../../../src/midnight/commitments.js')).MidnightCommitments as never,
  }),
  'approve-proposal': approveProposalAction({
    ...VAULTS,
    ...afterARemoval(VAULTS),
    commitments: async () => (await import('../../../../src/midnight/commitments.js')).MidnightCommitments as never,
    recovery: RECOVERY,
  }),
  'change-threshold': changeThresholdAction({ chain: VAULTS.chain, builder: VAULTS.builder, pause }),
  'remove-signer': removeSignerAction({ chain: VAULTS.chain, builder: VAULTS.builder, pause, ...afterARemoval(VAULTS) }),
  'rotate-vault-secrets': rotateVaultSecretsAction(VAULTS),
  'raise-run': raiseRunAction(VAULTS),
  'pay-run': payRunAction(VAULTS),
  'withdraw-proposal': withdrawProposalAction(VAULTS),
  recovery: recoveryAction(RECOVERY),
  'admit-signer': admitSignerAction({
    chain: VAULTS.chain, builder: VAULTS.builder, pause,
    commitments: async () => (await import('../../../../src/midnight/commitments.js')).MidnightCommitments as never,
  }),
  'admit-person': admitPersonAction({ chain: VAULTS.chain, builder: VAULTS.builder, network: NETWORK as never }),
  'change-person': changePersonAction({
    chain: VAULTS.chain, builder: VAULTS.builder, now: VAULTS.now, network: NETWORK as never,
    roundIdentity: async () => ((await import('../../../../contracts/managed/contract/index.js')) as unknown as { pureCircuits: RoundIdentity }).pureCircuits,
  }),
  'choose-company-service': chooseCompanyServiceAction({ chain: VAULTS.chain, builder: VAULTS.builder, pause }),
});

/** The definition of the action with this name, or `null` when this wallet runs none by that name. */
export function actionFor(name: string): ActionDefinition | null {
  const all = ACTIONS as Readonly<Record<string, ActionDefinition>>;
  return Object.prototype.hasOwnProperty.call(all, name) ? all[name] ?? null : null;
}

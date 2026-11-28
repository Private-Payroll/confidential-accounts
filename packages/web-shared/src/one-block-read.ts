/**
 * **ONE BLOCK, NAMED FIRST, AND THE CONTRACTS READ AS OF IT.** The one read of a
 * vault with its account, and of a company's account alone, at the newest block
 * the indexer names, and the form each crosses in: every state as base64 of its
 * bytes. The vault worker, the wallet and the company's service each hand it
 * their own reader. It imports nothing but the reader's type, so a service or a
 * wallet screen can use it without loading the worker.
 */
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';

/** The vault, the commitment tree, the ledger's parameters and the account, as one block holds them. */
export interface VaultAtOneBlock {
  readonly blockHash: string;
  readonly zswap: { serialize(): Uint8Array };
  readonly vault: { serialize(): Uint8Array };
  readonly parameters: { serialize(): Uint8Array };
  readonly account: { serialize(): Uint8Array };
}

/** One block's view of what a payment out is built on, every value base64 of its bytes. */
export interface PayoutChainOnTheWire {
  readonly blockHash: string;
  readonly vaultState: string;
  readonly zswapState: string;
  readonly parameters: string;
  readonly accountState: string;
}

/** One block's view of the company account, for a raise or an approval to be built on. Base64 of the bytes. */
export interface AccountCallChainOnTheWire {
  readonly blockHash: string;
  readonly accountState: string;
  readonly parameters: string;
}

/** The part of the indexer's reader that names a block and reads contracts as of it, as the package declares it. */
export type BlockReader = Pick<PublicDataProvider, 'queryBlock' | 'queryZSwapAndContractState' | 'queryContractState'>;

/**
 * **ONE BLOCK, NAMED FIRST, AND BOTH CONTRACTS READ AS OF IT.** The vault's
 * call reads the account's state inside the same circuit, so the two must be
 * the same moment; the commitment tree comes from that block too, because the
 * chain keeps only a window of past roots a spend may prove against. Null when
 * the indexer names no block, or holds either contract at none.
 */
export async function atOneBlockOver(r: BlockReader, vault: string, account: string): Promise<VaultAtOneBlock | null> {
  const block = await r.queryBlock();
  if (block === null) return null;
  const at = { type: 'blockHash' as const, blockHash: block.hash };
  const [both, accountRead] = await Promise.all([
    r.queryZSwapAndContractState(vault, at),
    r.queryContractState(account, at)
  ]);
  if (both === null || accountRead === null) return null;
  return {
    blockHash: block.hash,
    zswap: both.zswapChainState,
    vault: both.contractState,
    parameters: both.ledgerParameters,
    account: accountRead.contractState
  };
}

/** One read of a contract with the zswap state and the ledger's parameters, as the indexer's reader serves it. */
type StatesRead = NonNullable<Awaited<ReturnType<BlockReader['queryZSwapAndContractState']>>>;

/** The account's state and the ledger's parameters, as served, at the block named first. */
export interface AccountAtOneBlock {
  readonly blockHash: string;
  readonly account: StatesRead['contractState'];
  readonly parameters: StatesRead['ledgerParameters'];
}

/**
 * **ONE BLOCK, NAMED FIRST, AND THE ACCOUNT READ AS OF IT, WITH THE LEDGER'S
 * PARAMETERS THE SAME READ GIVES**: what a call to the account alone - a
 * recovery of its record anchor, its proposal and approvals - is built on, and
 * what tells whether a company's creation is finished. The one read of a
 * company's account at the newest block, wherever it is read: the vault
 * worker, the wallet and the service each hand it their own reader. Null when
 * the indexer names no block, or holds the account at none.
 */
export async function accountAtOneBlockOver(r: BlockReader, account: string): Promise<AccountAtOneBlock | null> {
  const block = await r.queryBlock();
  if (block === null) return null;
  const read = await r.queryZSwapAndContractState(account, { type: 'blockHash' as const, blockHash: block.hash });
  if (read === null) return null;
  return { blockHash: block.hash, account: read.contractState, parameters: read.ledgerParameters };
}

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** The vault and its account at one block as they cross to whoever builds the step: each state as base64 of its bytes. */
export const payoutChainOf = (at: VaultAtOneBlock | null): PayoutChainOnTheWire | null =>
  at === null
    ? null
    : {
        blockHash: at.blockHash,
        vaultState: toBase64(at.vault.serialize()),
        zswapState: toBase64(at.zswap.serialize()),
        parameters: toBase64(at.parameters.serialize()),
        accountState: toBase64(at.account.serialize())
      };

/** The account at one block as it crosses to whoever builds the call: each state as base64 of its bytes. */
export const accountCallChainOf = (
  at: {
    readonly blockHash: string;
    readonly account: { serialize(): Uint8Array };
    readonly parameters: { serialize(): Uint8Array };
  } | null
): AccountCallChainOnTheWire | null =>
  at === null
    ? null
    : {
        blockHash: at.blockHash,
        accountState: toBase64(at.account.serialize()),
        parameters: toBase64(at.parameters.serialize())
      };

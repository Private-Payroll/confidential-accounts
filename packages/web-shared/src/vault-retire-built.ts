/**
 * **A VAULT'S RETIRE, BUILT AND PROVED ON THE SIGNER'S OWN DEVICE.** The vault's own `retire` refuses while the vault
 * holds any note or any public money, and only then asks the company's account to retire it, under the proposal its
 * signers approved and that proposal's salt; the account checks both and that the vault is one it adopted. Runs in the
 * proving worker beside the vault's other transactions. The proposal and the salt come from the company's sealed record
 * as the page opened it; the chain's state from one block the wallet's indexer showed. Before it, each public token the
 * vault lists and holds none of is taken off its list by the vault's own `forgetUnshielded`, which refuses while the
 * vault holds any of that token: the vault's `retire` refuses while any token is listed.
 */
import { HEX64, fromHex, vaultCallWithTheAccount, type PayoutChain, type VaultBuilderDeps } from './vault-builder.js';
import { fromBase64, toBase64 } from './base64-bytes.js';
import type { PayoutChainOnTheWire } from './vault-worker-client.js';

/** The page's ask for a vault's retire: the approved proposal, its salt, and both contracts at one block, as base64. */
export interface RetireAsk {
  readonly id: number; readonly network: string; readonly ask: 'retire';
  readonly vault: string; readonly account: string; readonly proposal: string; readonly salt: string; readonly chain: PayoutChainOnTheWire;
}

/** One public token taken off the vault's list, built against one block's view of the vault and the company's account. */
export interface ForgetUnshieldedAsk {
  readonly id: number; readonly network: string; readonly ask: 'forget-unshielded';
  readonly vault: string; readonly account: string; readonly token: string; readonly chain: PayoutChainOnTheWire;
}

const bytes32Of = (what: string, value: unknown): Uint8Array => {
  const v = String(value ?? '').toLowerCase();
  if (!HEX64.test(v)) throw new Error(`the retire's ${what} is not thirty-two bytes, so nothing was built.`);
  return fromHex(v);
};

/**
 * The vault's retire under `proposal` and its `salt`, proved against `chain`. Refuses, before anything is built, a
 * vault, account, proposal or salt that is not thirty-two bytes; the vault and the account refuse the rest on the chain.
 */
export async function buildRetire(
  deps: VaultBuilderDeps,
  input: { readonly vault: string; readonly account: string; readonly proposal: string; readonly salt: string; readonly chain: PayoutChain },
): Promise<{ proven: Uint8Array }> {
  const vault = String(input.vault).toLowerCase();
  const account = String(input.account).toLowerCase();
  bytes32Of('vault', vault);
  bytes32Of('account', account);
  const args = [bytes32Of('proposal', input.proposal), bytes32Of('salt', input.salt)];
  return vaultCallWithTheAccount(deps, { vault, account, circuitId: 'retire', args, chain: input.chain });
}

/** The page's ask for a retire, answered in the worker with the proven transaction as base64. */
/**
 * The vault's `forgetUnshielded` for one token, which the vault carries out only while it holds none of that token. It
 * calls nothing else and moves no coin; the account's state rides along only because the builder reads one block of both.
 */
export async function buildForgetUnshielded(
  deps: VaultBuilderDeps,
  input: { readonly vault: string; readonly account: string; readonly token: string; readonly chain: PayoutChain },
): Promise<{ proven: Uint8Array }> {
  const vault = String(input.vault).toLowerCase();
  const account = String(input.account).toLowerCase();
  bytes32Of('vault', vault);
  bytes32Of('account', account);
  return vaultCallWithTheAccount(deps, { vault, account, circuitId: 'forgetUnshielded', args: [bytes32Of('token', input.token)], chain: input.chain });
}

/** The worker's answer to a retire, or to a token taken off the vault's list before it, each under its own ask. */
export async function retireAnswered(
  deps: VaultBuilderDeps, ask: RetireAsk | ForgetUnshieldedAsk,
): Promise<{ id: number; ok: true; ask: 'retire' | 'forget-unshielded'; tx: string }> {
  const c = ask.chain;
  const chain = {
    blockHash: c.blockHash, vaultState: fromBase64(c.vaultState), zswapState: fromBase64(c.zswapState),
    parameters: fromBase64(c.parameters), accountState: fromBase64(c.accountState),
  };
  const built = ask.ask === 'forget-unshielded'
    ? await buildForgetUnshielded(deps, { vault: ask.vault, account: ask.account, token: ask.token, chain })
    : await buildRetire(deps, { vault: ask.vault, account: ask.account, proposal: ask.proposal, salt: ask.salt, chain });
  return { id: ask.id, ok: true, ask: ask.ask, tx: toBase64(built.proven) };
}

/**
 * **A COMPANY VAULT'S THREE TRANSACTIONS, BUILT AND PROVED ON THE SIGNER'S OWN
 * DEVICE.**
 *
 *   1. the vault's deploy, pinned to the company's account and held for one
 *      block by a temporary key made here;
 *   2. the handover of that vault to the company's committee, signed by that
 *      temporary key and by nothing else;
 *   3. a deposit of one coin the device has already chosen and recorded.
 *
 * **RUNS IN THE PROVING WORKER**, where the ledger and the prover are allowed to
 * load; the page asks for these through `vault-worker-client.ts`. Everything it
 * needs is handed in, so the same code runs in a test against the ledger's own
 * objects.
 *
 * **WHAT LEAVES THIS FILE IS A PROVEN TRANSACTION AND NOTHING ELSE.** No
 * transaction this builds carries a coin of the device's: the deploy and the
 * handover move none, and the deposit's one output is the vault's. The two
 * public keys the call builder asks for are made from randomness nobody keeps.
 * The temporary key leaves to the page, which keeps it until the handover has
 * landed and never sends it anywhere.
 */
import { committeeReplacement, type Committee } from '../midnight/vault-committee.js';

export interface SigningKeyLike { readonly tag: string; readonly value: string }

export interface VaultBuilderDeps {
  /** `@midnightntwrk/ledger-v9`. */
  readonly ledger: any;
  /** `@midnight-ntwrk/compact-runtime`'s `ContractState`, which the call builder reads. */
  readonly runtimeState: { deserialize(bytes: Uint8Array): unknown };
  /** `createUnprovenDeployTxFromVerifierKeys` and `createUnprovenCallTxFromInitialStates`. */
  readonly contracts: {
    createUnprovenDeployTxFromVerifierKeys(...args: any[]): Promise<any>;
    createUnprovenCallTxFromInitialStates(...args: any[]): Promise<any>;
  };
  /** The vault's compiled contract, with its witnesses. */
  readonly compiled: unknown;
  /** Hands out the vault circuits' verifying keys. */
  readonly zkConfig: unknown;
  /** Proves an unproven transaction. `circuit` names the one it calls, when it calls one. */
  readonly prove: (unproven: any, circuit?: string) => Promise<{ serialize(): Uint8Array }>;
  readonly network: string;
  readonly random?: (n: number) => Uint8Array;
  readonly now?: () => number;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const HEX64 = /^[0-9a-f]{64}$/u;

/** Keys the call builder asks for, from randomness this function drops. */
const throwawayKeys = (deps: VaultBuilderDeps) => {
  const seed = (deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32);
  const keys = deps.ledger.ZswapSecretKeys.fromSeed(seed);
  const out = { coinPublicKey: keys.coinPublicKey, encryptionPublicKey: keys.encryptionPublicKey };
  seed.fill(0);
  try { keys.clear?.(); } catch { /* nothing to clear */ }
  return out;
};

/**
 * THE DEPLOY. The temporary key is a fresh BIP-340 key; its only job is to sign
 * the handover, and the page is given it for exactly that.
 */
export async function buildVaultDeploy(
  deps: VaultBuilderDeps, input: { readonly account: string },
): Promise<{ vault: string; temporaryKey: SigningKeyLike; proven: Uint8Array }> {
  const account = input.account.toLowerCase();
  if (!HEX64.test(account)) throw new Error('a vault is pinned to its company\'s account address, and this is not one.');
  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const secret = random(32);
  const temporaryKey = deps.ledger.signingKeyFromBip340(secret) as SigningKeyLike;
  secret.fill(0);
  const keys = throwawayKeys(deps);
  const built = await deps.contracts.createUnprovenDeployTxFromVerifierKeys(
    deps.zkConfig, keys.coinPublicKey,
    { compiledContract: deps.compiled, args: [{ bytes: fromHex(account) }], signingKey: temporaryKey },
    keys.encryptionPublicKey);
  const vault = String(built.public.contractAddress).toLowerCase();
  const proven = await deps.prove(built.private.unprovenTx);
  return { vault, temporaryKey: { tag: temporaryKey.tag, value: temporaryKey.value }, proven: proven.serialize() };
}

/**
 * THE HANDOVER. `counter` is the vault's counter as the chain reports it; the
 * page reads it immediately before asking.
 */
export async function buildCommitteeHandover(
  deps: VaultBuilderDeps,
  input: { readonly vault: string; readonly counter: bigint; readonly temporaryKey: SigningKeyLike; readonly to: Committee },
): Promise<{ proven: Uint8Array }> {
  const L = deps.ledger;
  let update = committeeReplacement(L, { vault: input.vault, counter: input.counter, to: input.to }) as any;
  update = update.addSignature(0n, L.signData(input.temporaryKey, update.dataToSign));
  const ttl = new Date((deps.now ?? Date.now)() + 30 * 60_000);
  const unproven = L.Transaction.fromParts(deps.network, undefined, undefined, L.Intent.new(ttl).addMaintenanceUpdate(update));
  const proven = await deps.prove(unproven);
  return { proven: proven.serialize() };
}

/**
 * THE DEPOSIT. `coin` is the one the device chose and recorded before this was
 * asked; `state` is the vault's state as the chain served it.
 */
export async function buildDeposit(
  deps: VaultBuilderDeps,
  input: {
    readonly vault: string;
    readonly coin: { readonly nonce: string; readonly token: string; readonly value: bigint };
    readonly state: Uint8Array;
  },
): Promise<{ proven: Uint8Array }> {
  const { nonce, token, value } = input.coin;
  if (!HEX64.test(nonce) || !HEX64.test(token) || value <= 0n) {
    throw new Error('this is not a coin a deposit can be made with, so nothing was built.');
  }
  const keys = throwawayKeys(deps);
  const L = deps.ledger;
  const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.zkConfig, {
    compiledContract: deps.compiled,
    circuitId: 'deposit',
    contractAddress: input.vault.toLowerCase(),
    coinPublicKey: keys.coinPublicKey,
    initialContractState: deps.runtimeState.deserialize(input.state),
    /* A deposit spends nothing of the chain's, so the builder is given no commitment tree to read. */
    initialZswapChainState: new L.ZswapChainState(),
    ledgerParameters: L.LedgerParameters.initialParameters(),
    args: [{ nonce: fromHex(nonce), color: fromHex(token), value }],
  }, keys.encryptionPublicKey);
  const proven = await deps.prove(built.private.unprovenTx, 'deposit');
  return { proven: proven.serialize() };
}

export { hex as hexOfBytes };

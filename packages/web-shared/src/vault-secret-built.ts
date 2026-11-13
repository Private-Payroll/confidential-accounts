/**
 * **A VAULT'S SECRET, SET AND COPIED ON THE SIGNER'S OWN DEVICE.** Builds and proves the call that sets the vault's
 * nonce secret under the run its signers approved, and the calls that write each signer's sealed copy of it. Runs in
 * the proving worker beside the vault's other transactions; everything it needs is handed in, and the secret is
 * handed in by the page that opened it from the company's records and is kept by nothing here.
 */
import { DIGITS, fromHex, HEX64, throwawayKeys, vaultCallWithTheAccount, type PayoutChain, type VaultBuilderDeps } from './vault-builder.js';
/**
 * **A SECRET RUN AS IT CROSSES BETWEEN THE PAGE AND THIS WORKER**, a first secret
 * or a replacement: every number as decimal digits and every value as hex. It is
 * made in this worker from the secret the page opened (`vault-start.ts`), and the page hands it back
 * unchanged for each step it builds.
 */
export interface SecretRunOnTheWire {
  readonly vault: string;
  readonly previous: string;
  readonly commitment: string;
  readonly copiesRoot: string;
  readonly count: string;
  readonly edge: ReadonlyArray<{ readonly sibling: string; readonly goesLeft: boolean }>;
  readonly details: string;
  readonly nonce: string;
  readonly salt: string;
  readonly asset: string;
  readonly root: string;
  readonly payees: string;
  readonly path: ReadonlyArray<{ readonly sibling: string; readonly siblingSum: string; readonly goesLeft: boolean }>;
  readonly copies: ReadonlyArray<{
    readonly reader: string;
    readonly parts: readonly string[];
    readonly path: ReadonlyArray<{ readonly sibling: string; readonly goesLeft: boolean }>;
  }>;
}

const digitsOf = (what: string, d: unknown): bigint => {
  if (typeof d !== 'string' || !DIGITS.test(d)) throw new Error(`the secret run's ${what} is not a whole number, so nothing was built.`);
  return BigInt(d);
};
const hex32Of = (what: string, h: unknown): Uint8Array => {
  if (typeof h !== 'string' || !HEX64.test(h)) throw new Error(`the secret run's ${what} is not thirty-two bytes, so nothing was built.`);
  return fromHex(h);
};

/**
 * **THE VAULT'S NONCE SECRET SET, UNDER THE RUN ITS SIGNERS APPROVED**, its first
 * or one replacing it. The vault asks the account's `approveVaultChange` inside
 * the same call, against the account's state as the same block saw it, and the
 * account refuses unless the run is open, approved at the vault's bar, and holds
 * this change as its one leaf. No coin moves; the vault mints the account one
 * change receipt. A replacement passes `earlier`, the secret whose copies the
 * vault last had all written, which it keeps sealed under the new one; without
 * it zero is passed, as the first secret needs.
 */
export async function buildSetNonceSecret(
  deps: VaultBuilderDeps,
  input: {
    readonly vault: string;
    readonly account: string;
    readonly run: SecretRunOnTheWire;
    /** The secret the run sets, which the vault takes only from a device that holds it; `earlier` the one it carries. */
    readonly secret: string; readonly earlier?: string;
    readonly proposal: string;
    readonly opensAt: string;
    readonly closesAt: string;
    readonly chain: PayoutChain;
  },
): Promise<{ proven: Uint8Array }> {
  const vault = String(input.vault).toLowerCase();
  const account = String(input.account).toLowerCase();
  const r = input.run;
  if (!Array.isArray(r?.edge) || r.edge.length !== 10) {
    throw new Error('this secret run does not show where its copies end, so nothing was built. Read the vault\'s start again to get a complete run.');
  }
  if (!HEX64.test(vault) || !HEX64.test(account) || String(r?.vault).toLowerCase() !== vault) {
    throw new Error('this secret is not for this vault and this company\'s account, so nothing was built.');
  }
  const run = {
    proposal: hex32Of('identity', input.proposal), runVault: fromHex(vault), root: hex32Of('root', r.root),
    payees: digitsOf('number of leaves', r.payees), opensAt: digitsOf('opening', input.opensAt),
    closesAt: digitsOf('close', input.closesAt), required: 0n, salt: hex32Of('salt', r.salt),
    nonce: hex32Of('nonce', r.nonce), asset: hex32Of('asset', r.asset),
    path: r.path.map((s) => ({ sibling: digitsOf('path', s.sibling), siblingSum: digitsOf('path', s.siblingSum), goesLeft: s.goesLeft === true })),
  };
  return vaultCallWithTheAccount(deps, {
    vault, account, circuitId: 'setNonceSecret', chain: input.chain,
    args: [
      run, hex32Of('previous secret', r.previous), hex32Of('commitment', r.commitment),
      hex32Of('root of copies', r.copiesRoot), digitsOf('number of copies', r.count),
      r.edge.map((s) => ({ sibling: digitsOf('path', s.sibling), goesLeft: s.goesLeft === true })),
      /* A first secret replaces none, so there is no earlier secret to carry. */
      hex32Of('secret', input.secret), input.earlier === undefined ? new Uint8Array(32) : hex32Of('earlier secret', input.earlier),
    ],
  });
}

/**
 * **ONE SIGNER'S SEALED COPY OF THE SECRET, WRITTEN INTO THE VAULT** against the
 * root of copies its signers approved. Anyone may write one; only a copy under
 * that root is taken, and each place in the tree once.
 */
export async function buildWriteSecretCopy(
  deps: VaultBuilderDeps,
  input: {
    readonly vault: string;
    readonly run: SecretRunOnTheWire;
    /** Which copy of the run, by its place in the tree. */
    readonly place: number;
    readonly state: Uint8Array;
    readonly parameters: Uint8Array;
  },
): Promise<{ proven: Uint8Array }> {
  const vault = String(input.vault).toLowerCase();
  const copy = input.run?.copies?.[input.place];
  if (!HEX64.test(vault) || String(input.run?.vault).toLowerCase() !== vault || copy === undefined) {
    throw new Error('this sealed copy is not one of this vault\'s secret run, so nothing was built.');
  }
  if (!Array.isArray(copy.parts) || copy.parts.length !== 4) {
    throw new Error('a sealed copy is four parts, and this is not, so nothing was built.');
  }
  if (!(input.parameters instanceof Uint8Array) || input.parameters.length === 0) {
    throw new Error('the chain\'s current ledger parameters were not handed over, so nothing was built or sent.');
  }
  const L = deps.ledger;
  const keys = throwawayKeys(deps);
  const built = await deps.contracts.createUnprovenCallTxFromInitialStates(deps.zkConfig, {
    compiledContract: deps.compiled,
    circuitId: 'writeSecretCopy',
    contractAddress: vault,
    coinPublicKey: keys.coinPublicKey,
    initialContractState: deps.runtimeState.deserialize(input.state),
    initialZswapChainState: new L.ZswapChainState(),
    ledgerParameters: L.LedgerParameters.deserialize(input.parameters),
    args: [
      hex32Of('commitment', input.run.commitment), hex32Of('reader key', copy.reader),
      copy.parts.map((p) => hex32Of('sealed copy', p)),
      copy.path.map((s) => ({ sibling: digitsOf('path', s.sibling), goesLeft: s.goesLeft === true })),
    ],
  }, keys.encryptionPublicKey);
  const proven = await deps.prove(built.private.unprovenTx, 'writeSecretCopy');
  return { proven: proven.serialize() };
}

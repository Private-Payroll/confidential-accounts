/**
 * The customer's wallet, in a browser tab.
 *
 * This is the link the web path was missing. Everything else in the browser
 * chain is proven — the prover loads, the queue runs on a Worker with
 * IndexedDB, and the prove/balance/submit split settles on chain
 * — but every one of those runs balanced and signed with a testkit wallet in a
 * Node process. A tab has no such thing. It has a wallet extension, reached
 * through `@midnightntwrk/dapp-connector-api`, and this file is the adapter.
 *
 * THE HAPPY SURPRISE: THE CONNECTOR ALREADY HAS OUR SHAPE.
 *
 *   ours (src/midnight/job-runner.ts)   connector
 *   ---------------------------------   ------------------------------------
 *   proofProvider.proveTx               we do this ourselves — see below
 *   walletProvider.balanceTx            balanceUnsealedTransaction(tx)
 *   midnightProvider.submitTx           submitTransaction(tx)
 *
 * `balanceUnsealedTransaction` is documented as taking a transaction that
 * already carries proofs — `Transaction<SignatureEnabled, Proof, PreBinding>`.
 * So the connector expects prove-then-balance-then-submit, in that order, which
 * is exactly the split decision 0008 arrived at independently and M-82 settled
 * on chain. Nothing above this file has to change to run in a browser.
 *
 * WHO PROVES, AND WHY WE DEFAULT TO OURSELVES.
 *
 * The API offers `getProvingProvider`, which delegates proving to the wallet.
 * It is optional, and as of August 2026 the split is:
 *
 *   1AM   implements it — delegated proving
 *   Lace  does NOT (confirmed by Midnight staff on the forum). It offers
 *         `getConfiguration().proverServerUri` instead, i.e. a proof server.
 *
 * A proof server is not an option for us at any price. The preimage contains
 * the account balance, the payment amount and the signer's secret key — the
 * exact things the product promises nobody can see — which is decision 0007.
 * So for a Lace user the only honest path is the one M-77 and M-87 established:
 * **we prove in the browser ourselves.**
 *
 * That makes delegated proving an OPTIMISATION rather than a dependency, and
 * this file treats it that way: use the wallet's prover when it has one, use
 * ours when it does not, and never reach for a proof server. It also means the
 * product works on both wallets on day one instead of only on 1AM.
 *
 * One thing this file cannot establish, and nobody should assume: whether a
 * wallet that offers `getProvingProvider` proves LOCALLY or ships the preimage
 * somewhere. Delegation moves the work to another process, not necessarily to
 * another machine. Until that is confirmed for a given wallet, `preferWallet`
 * defaults to false.
 */
import type { Hex } from '../core/crypto.js';

/* ------------------------------------------------------------------ *
 * the slice of the connector we use
 *
 * Declared structurally rather than imported, so this module typechecks in
 * Node and in the tests, where `window.midnight` does not exist. The package is
 * installed and is the source these were read from — not a guess.
 * ------------------------------------------------------------------ */

export interface ConnectorConfiguration {
  indexerUri: string;
  indexerWsUri: string;
  substrateNodeUri: string;
  networkId: string;
  /** Deprecated upstream, and refused here regardless. See decision 0007. */
  proverServerUri?: string;
}

export interface ConnectedWallet {
  getShieldedAddresses(): Promise<{
    shieldedAddress: string;
    shieldedCoinPublicKey: string;
    shieldedEncryptionPublicKey: string;
  }>;
  balanceUnsealedTransaction(tx: string, options?: { payFees?: boolean }): Promise<{ tx: string }>;
  submitTransaction(tx: string): Promise<void>;
  getConfiguration(): Promise<ConnectorConfiguration>;
  getProvingProvider?(keyMaterialProvider: unknown): Promise<unknown>;
  hintUsage?(methodNames: string[]): Promise<void>;
}

export interface InstalledWallet {
  rdns: string;
  name: string;
  icon: string;
  apiVersion: string;
  connect(networkId: string): Promise<ConnectedWallet>;
}

/**
 * Every wallet the browser is offering.
 *
 * A single wallet may inject several entries — one per API version it supports
 * — so this returns a list rather than picking, and the choice is the user's.
 * Names and icons come from the extension and are therefore untrusted input:
 * render the name as a text node and the icon in an `img`, never as HTML.
 */
export const installedWallets = (scope: any): InstalledWallet[] => {
  const injected = scope?.midnight;
  if (!injected || typeof injected !== 'object') return [];
  return Object.values(injected).filter(
    (w: any) => w && typeof w.connect === 'function' && typeof w.rdns === 'string',
  ) as InstalledWallet[];
};

/** How this session ended up proving, so the interface can be honest about it. */
export type ProvingMode = 'wallet' | 'in-browser';

export interface ConnectorOptions {
  /**
   * Use the wallet's prover when it has one.
   *
   * Defaults to FALSE, deliberately. Delegation moves proving to another
   * process; whether that process is on this machine is a question about a
   * specific wallet, not about the API. Proving in our own tab is the only
   * option we can verify ourselves, so it is the default, and turning this on
   * should follow a confirmation rather than an assumption.
   */
  preferWallet?: boolean;
  /** Our own in-browser prover — `wasmProofProvider` from `wasm-proving.ts`. */
  fallbackProofProvider: { proveTx(tx: unknown, config?: unknown): Promise<unknown> };
  /** `Transaction` from the ledger package, injected so this file stays isomorphic. */
  transactionCodec: {
    serialize(tx: unknown): Uint8Array;
    deserialize(raw: Uint8Array): unknown;
  };
  keyMaterialProvider?: unknown;
}

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const fromBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

/**
 * The three providers `MidnightJobRunner` needs, over a wallet extension.
 *
 * Returned as one object because they must come from the SAME connection: a
 * transaction balanced by one wallet and submitted by another is a transaction
 * nobody can account for.
 */
export const connectorProviders = async (wallet: ConnectedWallet, options: ConnectorOptions) => {
  /*
   * Ask for permissions up front, in one prompt, rather than one at a time
   * mid-approval.
   *
   * The API exists for exactly this. Without it a signer gets a permission
   * dialog in the middle of a job that is already proving, which reads as the
   * application being broken and — worse — arrives at the one moment they are
   * least able to judge it.
   */
  await wallet.hintUsage?.([
    'getShieldedAddresses',
    'balanceUnsealedTransaction',
    'submitTransaction',
    'getConfiguration',
  ]);

  let provingMode: ProvingMode = 'in-browser';
  let proveTx = options.fallbackProofProvider.proveTx.bind(options.fallbackProofProvider);

  if (options.preferWallet && typeof wallet.getProvingProvider === 'function') {
    try {
      const delegated: any = await wallet.getProvingProvider(options.keyMaterialProvider);
      if (typeof delegated?.prove === 'function') {
        provingMode = 'wallet';
        proveTx = async (tx: unknown) => delegated.prove(tx);
      }
    } catch {
      /*
       * A wallet that offers the method and then fails is not a reason to stop:
       * we have a prover of our own that is already proven to work in a tab.
       * Falling back silently is right here because the outcome is identical
       * to the user — a proof — and the mode is reported separately for anyone
       * who wants to know which one produced it.
       */
    }
  }

  const config = await wallet.getConfiguration();

  return {
    provingMode,
    /** Indexer and node endpoints as the WALLET has them, not as we guessed. */
    config,

    proofProvider: { proveTx: (tx: unknown, cfg?: unknown) => proveTx(tx, cfg) },

    walletProvider: {
      /*
       * `ttl` is accepted and discarded: the connector owns the expiry, because
       * the wallet is the party paying and it decides how long its own inputs
       * stay committed. Pretending to control it here would be a lie in the
       * type.
       */
      async balanceTx(tx: unknown, _ttl?: Date) {
        const wire = toBase64(options.transactionCodec.serialize(tx));
        const { tx: balanced } = await wallet.balanceUnsealedTransaction(wire, { payFees: true });
        return options.transactionCodec.deserialize(fromBase64(balanced));
      },
      getCoinPublicKey: async () => (await wallet.getShieldedAddresses()).shieldedCoinPublicKey,
      getEncryptionPublicKey: async () =>
        (await wallet.getShieldedAddresses()).shieldedEncryptionPublicKey,
    },

    midnightProvider: {
      /*
       * `submitTransaction` returns void, and our runner needs an id — a job
       * that settles without one cannot be looked up or shown to anyone later.
       *
       * The honest answer is not to invent one. Recovery in this system asks
       * the ACCOUNT whether a job's effect is present rather than asking about
       * a transaction id, so an absent id costs nothing there; it costs
       * only the ability to link a settled job to a block explorer. Marked as
       * such rather than filled with a plausible-looking hash.
       */
      async submitTx(tx: unknown): Promise<string> {
        const wire = toBase64(options.transactionCodec.serialize(tx));
        await wallet.submitTransaction(wire);
        return 'submitted-via-wallet';
      },
    },
  };
};

/**
 * Refuses a wallet that can only prove by sending the preimage to a server.
 *
 * Not a capability check — a policy one, and it belongs in code rather than in
 * a document. `proverServerUri` is the path of least resistance for anyone
 * wiring this up in a hurry, it is what the Foundation's own examples fall back
 * to, and taking it would quietly break the single promise the product is built
 * on. Decision 0007.
 */
export const refuseHostedProving = (config: ConnectorConfiguration, provingMode: ProvingMode) => {
  if (provingMode === 'in-browser' || provingMode === 'wallet') return;
  throw new Error(
    'this wallet can only prove using a proof server, and the proof preimage contains ' +
      'the account balance, the payment amount and the signer secret key. ' +
      'Sending it to a server would defeat the product. Prove in the browser instead.',
  );
};

/** Convenience for a UI that wants to say which wallet is connected. */
export const describeWallet = (w: InstalledWallet): string =>
  `${w.name} (${w.rdns}, connector API ${w.apiVersion})`;

export type { Hex };

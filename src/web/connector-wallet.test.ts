/**
 * The wallet adapter. M-10.
 *
 * A real wallet extension cannot be driven from a test — or from the cloud
 * container this was written in — so what is checked here is the ORDER and the
 * POLICY, which is where this file can be wrong in ways that matter: proving
 * somewhere it should not, balancing something unproven, or connecting to one
 * wallet and submitting through another.
 *
 * The remaining risk is honest and stated in M-10: a real extension may refuse
 * our transaction shape outright, and only a browser with one installed can say.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  connectorProviders, installedWallets, describeWallet,
  type ConnectedWallet, type ConnectorOptions,
} from './connector-wallet.js';

const codec: ConnectorOptions['transactionCodec'] = {
  serialize: (tx: any) => new TextEncoder().encode(JSON.stringify(tx)),
  deserialize: (raw) => JSON.parse(new TextDecoder().decode(raw)),
};

const wallet = (over: Partial<ConnectedWallet> = {}): ConnectedWallet => ({
  getShieldedAddresses: async () => ({
    shieldedAddress: 'addr', shieldedCoinPublicKey: 'cpk', shieldedEncryptionPublicKey: 'epk',
  }),
  balanceUnsealedTransaction: async (tx) => ({ tx }),
  submitTransaction: async () => {},
  getConfiguration: async () => ({
    indexerUri: 'https://indexer', indexerWsUri: 'wss://indexer',
    substrateNodeUri: 'https://node', networkId: 'stagenet',
  }),
  ...over,
});

const opts = (over: Partial<ConnectorOptions> = {}): ConnectorOptions => ({
  fallbackProofProvider: { proveTx: async () => ({ proven: true }) },
  transactionCodec: codec,
  ...over,
});

describe('connectorProviders', () => {
  it('proves in the browser by default, even when the wallet offers to', async () => {
    /*
     * THE POLICY TEST. Delegation moves proving to another process; whether
     * that process is on this machine is a question about a specific wallet,
     * not about the API. Our own prover is the one we can verify, so it is the
     * default and turning it off has to be deliberate. Decision 0007.
     */
    const walletProve = vi.fn(async () => ({ proven: 'by wallet' }));
    const ours = vi.fn(async () => ({ proven: 'by us' }));
    const p = await connectorProviders(
      wallet({ getProvingProvider: async () => ({ prove: walletProve }) }),
      opts({ fallbackProofProvider: { proveTx: ours } }),
    );
    await p.proofProvider.proveTx('tx');
    expect(p.provingMode).toBe('in-browser');
    expect(ours).toHaveBeenCalled();
    expect(walletProve).not.toHaveBeenCalled();
  });

  it('uses the wallet prover only when explicitly asked', async () => {
    const walletProve = vi.fn(async () => ({ proven: 'by wallet' }));
    const p = await connectorProviders(
      wallet({ getProvingProvider: async () => ({ prove: walletProve }) }),
      opts({ preferWallet: true }),
    );
    await p.proofProvider.proveTx('tx');
    expect(p.provingMode).toBe('wallet');
    expect(walletProve).toHaveBeenCalled();
  });

  it('falls back to our prover when the wallet has none — the Lace case', async () => {
    // Lace does not implement getProvingProvider (confirmed by Midnight staff).
    // A product that only worked on 1AM would be a product for one wallet.
    const p = await connectorProviders(wallet(), opts({ preferWallet: true }));
    expect(p.provingMode).toBe('in-browser');
  });

  it('falls back when the wallet offers a prover and then fails', async () => {
    const p = await connectorProviders(
      wallet({ getProvingProvider: async () => { throw new Error('denied'); } }),
      opts({ preferWallet: true }),
    );
    expect(p.provingMode).toBe('in-browser');
    await expect(p.proofProvider.proveTx('tx')).resolves.toBeTruthy();
  });

  it('NEVER reaches for the proof server, even when the wallet advertises one', async () => {
    /*
     * `proverServerUri` is the path of least resistance and it is what the
     * Foundation's own examples fall back to. The preimage contains the
     * balance, the amount and the signer's secret key.
     */
    const p = await connectorProviders(
      wallet({
        getConfiguration: async () => ({
          indexerUri: 'https://indexer', indexerWsUri: 'wss://indexer',
          substrateNodeUri: 'https://node', networkId: 'stagenet',
          proverServerUri: 'https://prover.example.com',
        }),
      }),
      opts(),
    );
    expect(p.provingMode).toBe('in-browser');
    expect(JSON.stringify(p.proofProvider)).not.toContain('prover.example.com');
  });

  it('balances through the wallet and hands back a transaction, not a string', async () => {
    // The runner passes objects to submit; a string leaking through here would
    // be serialised twice and rejected by the node with something unhelpful.
    const balance = vi.fn(async (tx: string) => ({ tx }));
    const p = await connectorProviders(wallet({ balanceUnsealedTransaction: balance }), opts());
    const out = await p.walletProvider.balanceTx({ hello: 'world' });
    expect(balance).toHaveBeenCalledOnce();
    expect(out).toEqual({ hello: 'world' });
  });

  it('asks the wallet to pay the fees', async () => {
    const balance = vi.fn(async (tx: string, options?: { payFees?: boolean }) => { void options; return { tx }; });
    const p = await connectorProviders(wallet({ balanceUnsealedTransaction: balance }), opts());
    await p.walletProvider.balanceTx({ a: 1 });
    expect(balance.mock.calls[0][1]).toEqual({ payFees: true });
  });

  it('asks for every permission up front, in one prompt', async () => {
    /*
     * Otherwise a signer gets a permission dialog in the middle of a job that
     * is already proving — which reads as the app being broken, and arrives at
     * the moment they are least able to judge it.
     */
    const hintUsage = vi.fn(async (methodNames: string[]) => { void methodNames; });
    await connectorProviders(wallet({ hintUsage }), opts());
    expect(hintUsage).toHaveBeenCalledOnce();
    expect(hintUsage.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['balanceUnsealedTransaction', 'submitTransaction']),
    );
  });

  it('takes the endpoints from the wallet rather than guessing them', async () => {
    // The user may be on a different indexer for privacy or performance
    // reasons. Overriding their choice silently is not ours to do.
    const p = await connectorProviders(wallet(), opts());
    expect(p.config.indexerUri).toBe('https://indexer');
    expect(p.config.networkId).toBe('stagenet');
  });

  it('submits, and does not invent a transaction id it does not have', async () => {
    /*
     * `submitTransaction` returns void. A plausible-looking hash here would be
     * a lie that surfaces later as a link to a transaction that does not exist.
     * Recovery asks the account rather than the id (M-82), so the honest
     * placeholder costs nothing that matters.
     */
    const submit = vi.fn(async () => {});
    const p = await connectorProviders(wallet({ submitTransaction: submit }), opts());
    const ref = await p.midnightProvider.submitTx({ a: 1 });
    expect(submit).toHaveBeenCalledOnce();
    expect(ref).toBe('submitted-via-wallet');
    expect(ref).not.toMatch(/^0x[0-9a-f]{16}/);
  });
});

describe('installedWallets', () => {
  it('finds what the browser injected', () => {
    const scope = { midnight: {
      'uuid-1': { rdns: 'com.lace', name: 'Lace', icon: '', apiVersion: '4.1.0', connect: async () => ({}) },
      'uuid-2': { rdns: 'xyz.1am', name: '1AM', icon: '', apiVersion: '4.1.0', connect: async () => ({}) },
    } };
    expect(installedWallets(scope).map((w) => w.rdns)).toEqual(['com.lace', 'xyz.1am']);
  });

  it('is empty rather than broken when no wallet is installed', () => {
    expect(installedWallets({})).toEqual([]);
    expect(installedWallets({ midnight: null })).toEqual([]);
  });

  it('ignores entries that are not a connector', () => {
    // `window.midnight` is writable by any script on the page.
    const scope = { midnight: { junk: { rdns: 'x' }, ok: { rdns: 'a.b', name: 'W', icon: '', apiVersion: '1', connect: async () => ({}) } } };
    expect(installedWallets(scope).map((w) => w.rdns)).toEqual(['a.b']);
  });

  it('describes a wallet without trusting its name as markup', () => {
    const d = describeWallet({ rdns: 'com.x', name: '<img onerror=alert(1)>', icon: '', apiVersion: '4.1.0', connect: null as any });
    // The string is carried verbatim; escaping is the renderer's job and the
    // module documents that. What matters is that we do not build HTML here.
    expect(d).toContain('<img onerror=alert(1)>');
    expect(d).toContain('com.x');
  });
});

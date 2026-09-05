/**
 * The network id is a string segment inside every address the SDK encodes.
 * Getting its shape wrong does not fail at compile time and does not fail at
 * provider assembly. It fails on the first transaction, inside the SDK, with a
 * message that does not mention network ids.
 *
 * These tests execute the real address codec from node_modules. They need no
 * node, no proof server and no Docker, which is the point: this whole bug class
 * was reachable offline the entire time and nothing was looking.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ShieldedCoinPublicKey } from '@midnightntwrk/wallet-sdk-address-format';
import { parseCoinPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NETWORKS, ENDPOINTS, applyNetworkId, networkFromEnv, isNetworkName, hasTestkitEnvironment, exportTestkitEnv } from './network.js';

/** A coin public key as it would really arrive from a wallet on `network`. */
const addressOn = (network: string) =>
  String(ShieldedCoinPublicKey.codec.encode(network, new ShieldedCoinPublicKey(Buffer.alloc(32, 7))));

describe('network id: the regression that could never have worked', () => {
  beforeEach(() => setNetworkId('undeployed'));

  it('is interpolated verbatim into the address, so its shape is load bearing', () => {
    expect(addressOn('preview')).toMatch(/^mn_shield-cpk_preview1/);
    expect(addressOn('testnet')).toMatch(/^mn_shield-cpk_testnet1/);
    // The codec validates nothing but the character set. Any string is taken
    // literally, which is why a wrong one fails late instead of loudly.
    expect(addressOn('stagenet')).toMatch(/^mn_shield-cpk_stagenet1/);
  });

  it('REGRESSION: the numeric enum that caused this no longer exists in 5.0', async () => {
    // The original bug was `setNetworkId(ledger.NetworkId[name])`, which passed
    // a NUMBER because `@midnight-ntwrk/ledger` exported `NetworkId` as a
    // numeric enum. On the 5.0 stack that package is gone entirely — the ledger
    // arrives as `@midnightntwrk/ledger-v9` via midnight-js-protocol — and
    // neither exports a `NetworkId` at all.
    //
    // So the mistake is now unmakeable rather than merely fixed, which is the
    // outcome worth asserting. If a future version reintroduces the enum, this
    // fails and we look again.
    const ledger: any = await import('@midnightntwrk/ledger-v9');
    expect(ledger.NetworkId).toBeUndefined();
    const protocol: any = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
    expect(protocol.NetworkId).toBeUndefined();
  });

  it('REGRESSION: a numeric id fails, and not consistently, which is the point', () => {
    // The enum for `undeployed` was 0, and 0 is refused by the codec outright.
    expect(() => addressOn('0')).toThrow(/disallowed characters/);

    // But 2 — the enum for TestNet, and the value that actually shipped — is a
    // legal character, so it encodes happily into a well-formed address for a
    // network that does not exist. That asymmetry is exactly why this bug was
    // slow rather than loud: sometimes a hard error, sometimes a valid-looking
    // address that every subsequent call rejects for an unrelated-sounding
    // reason. Asserting the encode succeeds documents the trap.
    expect(addressOn('2')).toMatch(/^mn_shield-cpk_21/);
  });

  it('the lowercase name round-trips on every network we support', async () => {
    for (const name of NETWORKS) {
      await applyNetworkId(name);
      expect(getNetworkId()).toBe(name);
      const hex = parseCoinPublicKeyToHex(addressOn(name), getNetworkId());
      expect(hex).toBe('07'.repeat(32));
    }
  });

  it('matches what the Foundation testkit does, which is the authority here', async () => {
    // testkit-js@4.1.1 getTestEnvironment(): setNetworkId('preview') etc.
    await applyNetworkId('preview');
    expect(getNetworkId()).toBe('preview');
    expect(typeof getNetworkId()).toBe('string');
  });
});

describe('network selection', () => {
  it('rejects a name that is not a network at all', () => {
    expect(() => networkFromEnv('Testnet2')).toThrow(/not a network this toolchain knows/);
  });

  it('accepts stagenet, which it used to refuse', () => {
    // M-45. The old message told people stagenet meant preview or preprod. It
    // is its own chain, and the Foundation's guidance is to build on it.
    expect(networkFromEnv('stagenet')).toBe('stagenet');
    expect(networkFromEnv('STAGENET')).toBe('stagenet');
    expect(isNetworkName('stagenet')).toBe(true);
  });

  it('accepts any case and defaults to preview', () => {
    expect(networkFromEnv('PREVIEW')).toBe('preview');
    expect(networkFromEnv(undefined)).toBe('preview');
    expect(networkFromEnv('')).toBe('preview');
    expect(isNetworkName('preprod')).toBe(true);
  });

  it('carries the v4 indexer path, not the v1 path we had in .env.example', () => {
    for (const [name, e] of Object.entries(ENDPOINTS)) {
      expect(e!.indexerUrl, name).toContain('/api/v4/graphql');
      expect(e!.indexerWsUrl, name).toContain('/api/v4/graphql/ws');
    }
    expect(ENDPOINTS.preview!.faucetUrl).toBe('https://faucet.preview.midnight.network/api/drips');
  });

  it('knows stagenet is on shielded.tools, not midnight.network', () => {
    const e = ENDPOINTS.stagenet!;
    expect(e.indexerUrl).toBe('https://indexer.stagenet.shielded.tools/api/v4/graphql');
    expect(e.nodeUrl).toBe('https://rpc.stagenet.shielded.tools');
    expect(e.nodeWsUrl).toBe('wss://rpc.stagenet.shielded.tools');
    expect(e.faucetUrl).toBe('https://faucet.stagenet.shielded.tools');
  });
});

describe('stagenet has no testkit environment class, so it goes through env vars', () => {
  it('knows which networks testkit ships a class for', () => {
    // Checked against testkit-js@5.0.0-beta.4's exports: Preview, Preprod,
    // Qanet, Local, EnvVar. No Stagenet, in 4.1.1 or 5.0.
    expect(hasTestkitEnvironment('preview')).toBe(true);
    expect(hasTestkitEnvironment('preprod')).toBe(true);
    expect(hasTestkitEnvironment('qanet')).toBe(true);
    expect(hasTestkitEnvironment('stagenet')).toBe(false);
  });

  it('sets exactly the variables EnvVarRemoteTestEnvironment reads', () => {
    const vars = exportTestkitEnv('stagenet');
    // Names taken from the built testkit, not guessed.
    expect(vars.MN_TEST_NETWORK_ID).toBe('stagenet');
    expect(vars.MN_TEST_WALLET_NETWORK_ID).toBe('stagenet');
    expect(vars.MN_TEST_INDEXER).toContain('indexer.stagenet.shielded.tools');
    expect(vars.MN_TEST_INDEXER_WS).toContain('wss://');
    expect(vars.MN_TEST_NODE).toBe('https://rpc.stagenet.shielded.tools');
    expect(vars.MN_TEST_NODE_WS).toBe('wss://rpc.stagenet.shielded.tools');
    expect(vars.MN_TEST_FAUCET).toBe('https://faucet.stagenet.shielded.tools');
    // And it really put them in the environment, not just returned them.
    expect(process.env.MN_TEST_NODE).toBe('https://rpc.stagenet.shielded.tools');
  });

  it('derives a websocket node url when one is not given explicitly', () => {
    const vars = exportTestkitEnv('preview');
    expect(vars.MN_TEST_NODE_WS).toBe('wss://rpc.preview.midnight.network');
  });
});

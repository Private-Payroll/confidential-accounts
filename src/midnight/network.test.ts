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
import { fileURLToPath } from 'node:url';
import {
  NETWORKS, ENDPOINTS, applyNetworkId, theNetwork, theNetworkNamed, theNetworkRecord, PAIR_NETWORK,
  isNetworkName, hasTestkitEnvironment, exportTestkitEnv,
} from './network.js';
import { NETWORK_IDS, endpointsOf, isNetworkId, networkRecord } from '../core/networks.js';

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

/**
 * **THERE IS ONE READER OF THE ENVIRONMENT AND THIS IS WHAT IT DOES.**
 *
 * Every assertion below names the change that turns it red, because the thing
 * being pinned is a refusal, and a refusal nobody has watched say no is a
 * claim rather than a guard.
 */
describe('network selection: the one reader, and what it refuses', () => {
  const asked = (name: string | undefined) => theNetwork({ MIDNIGHT_NETWORK_ID: name });

  it('REFUSES a name no record exists for, and names the ones that do', () => {
    for (const invented of ['Testnet2', 'STAGENET', 'stagenet2', 'prod', 'production',
      'main', 'localhost', 'undefined', 'null', 'devnet', 'testnet']) {
      /*
       * RED WHEN an unknown name resolves to anything at all. A guess is worse
       * than the defect it hides: it is silent, and the first thing that tells
       * anybody is an address no wallet can read.
       *
       * `devnet` and `testnet` are in this list on purpose. They are names the
       * platform's codec will happily encode and this application has written
       * no record for, which is exactly the case a permit-list is for.
       */
      expect(() => asked(invented), invented).toThrow(/names no network this application has a record for/);
      /* RED WHEN the refusal stops saying what would resolve it. */
      expect(() => asked(invented), invented).toThrow(new RegExp(NETWORK_IDS.join(', ')));
    }
  });

  it('REFUSES a name that has a record but is not the one this build is compiled for', () => {
    const other = NETWORK_IDS.find(id => id !== PAIR_NETWORK)!;
    /*
     * RED WHEN the environment can select a network again. A name is a segment
     * of every address, so a deployment able to disagree with the wallet it
     * signs people in with writes addresses that wallet cannot read.
     */
    expect(() => asked(other)).toThrow(/disagrees with the wallet/);
    expect(() => asked(other)).toThrow(new RegExp(PAIR_NETWORK));
  });

  it('naming nothing is the ordinary case and is NOT a default', () => {
    /*
     * RED WHEN an unset variable resolves to a written-down name rather than
     * to the constant both products are compiled against.
     */
    expect(asked(undefined)).toBe(PAIR_NETWORK);
    expect(asked('')).toBe(PAIR_NETWORK);
    expect(asked('   ')).toBe(PAIR_NETWORK);
    expect(theNetwork({})).toBe(PAIR_NETWORK);
  });

  it('the build has a record, and the record says what kind of network it is', () => {
    /*
     * RED WHEN the pair moves to a network nobody has written a record for,
     * which is a build that cannot say whether real money settles where it is
     * pointed.
     */
    expect(isNetworkId(PAIR_NETWORK)).toBe(true);
    expect(theNetworkRecord({}).id).toBe(PAIR_NETWORK);
    expect(['test', 'real']).toContain(theNetworkRecord({}).kind);
  });

  it('every id is a name the toolchain takes, round-tripped through the real codec', async () => {
    /*
     * **THE PLATFORM PUBLISHES NO LIST OF NETWORK NAMES.**
     * `@midnight-ntwrk/midnight-js-network-id` declares `NetworkId = string`
     * and `setNetworkId` takes any string, so there is nothing to ask it for.
     * What there is instead is the address codec, which is where a wrong name
     * does its damage, so every id is put through an encode and a decode here.
     *
     * RED WHEN a record carries an id the codec cannot round-trip, which is an
     * id that would produce addresses nothing can read.
     */
    for (const id of NETWORK_IDS) {
      await applyNetworkId(id);
      const hex = parseCoinPublicKeyToHex(addressOn(id), getNetworkId());
      expect(hex, id).toBe('07'.repeat(32));
      /*
       * RED WHEN a record's id stops being one of the names the two products
       * share, which is the list the wallet's own address checks use.
       */
      expect(isNetworkName(id), id).toBe(true);
    }
  });

  it('A BUILD COMPILED FOR A NETWORK WITH NO RECORD REFUSES, AND SAYS SO', () => {
    /*
     * **THE ONE REFUSAL THAT CANNOT BE WATCHED THROUGH THE ENVIRONMENT.** The
     * constant it is about is compiled into another package on purpose, and a
     * way to vary it would be the override this design exists to remove - so
     * the rules are a function of the two values they are about, and this
     * drives the pair directly.
     *
     * RED WHEN a build is allowed to run on a network nobody has written a
     * record for, which is a build that cannot say whether real money settles
     * where it is pointed.
     */
    expect(() => theNetworkNamed(undefined, 'devnet'))
      .toThrow(/this build is compiled for "devnet" and there is no record for that network/);
    expect(() => theNetworkNamed('stagenet', 'devnet')).toThrow(/no record for that network/);
    /* And a pair with a record resolves, so the refusal is not a wall. */
    expect(theNetworkNamed(undefined, 'preview')).toBe('preview');
    expect(theNetworkNamed('preview', 'preview')).toBe('preview');
    /*
     * RED WHEN an unset variable resolves to a name written down rather than to
     * the pair it was handed. With the real constant this is invisible, because
     * the name somebody would write down is the name the pair happens to have.
     */
    expect(theNetworkNamed(undefined, 'preprod')).toBe('preprod');
    expect(() => theNetworkNamed('stagenet', 'preprod')).toThrow(/disagrees with the wallet/);
  });

  it('THE ONE READER WRITES DOWN NO NETWORK NAME OF ITS OWN', async () => {
    /*
     * RED WHEN a name is typed into the resolver. With the pair on `stagenet`,
     * `return 'stagenet'` and `return PAIR_NETWORK` behave identically and no
     * behavioural test can tell them apart - so this is asked of the text.
     * Everything the resolver knows about networks it reads from the records
     * and from the wallet's own constant.
     */
    const { readFileSync } = await import('node:fs');
    const source: string = readFileSync(
      fileURLToPath(new URL('./network.ts', import.meta.url)), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    for (const id of NETWORK_IDS) {
      /* The one exception is the list testkit ships a class for, which is a
       * fact about testkit and not about which network this build is on. */
      const outsideTestkit = code.replace(/TESTKIT_ENVIRONMENTS[^;]+;/, ' ');
      expect(outsideTestkit, id).not.toMatch(new RegExp(`['"\`]${id}['"\`]`));
    }
    expect(code).toContain("TESTKIT_ENVIRONMENTS = ['preview', 'preprod', 'qanet']");
  });

  it('the disagreement refusal names both values and both homes', () => {
    let said = '';
    try { theNetworkNamed('preview', 'stagenet'); } catch (e) { said = (e as Error).message; }
    /* RED WHEN the refusal stops saying what was asked for, what this build is
     * for, or where the second value lives - which is the only part a person
     * can act on. */
    expect(said).toContain('preview');
    expect(said).toContain('stagenet');
    expect(said).toContain('MIDNIGHT_NETWORK_ID');
    expect(said).toContain('midnight-identity/network');
  });

  it('carries the v4 indexer path, not the v1 path we had in .env.example', () => {
    for (const [name, e] of Object.entries(ENDPOINTS)) {
      expect(e!.indexerUrl, name).toContain('/api/v4/graphql');
      expect(e!.indexerWsUrl, name).toContain('/api/v4/graphql/ws');
    }
    expect(ENDPOINTS.preview!.faucetUrl).toBe('https://faucet.preview.midnight.network/api/drips');
  });

  it('A NETWORK THAT GIVES NO TEST MONEY AWAY IS NOT GIVEN A FAUCET', () => {
    const noFaucet = NETWORK_IDS.filter((id) => {
      const e = networkRecord(id).endpoints;
      return e !== null && e.faucet === null;
    });
    /* RED WHEN every reachable network has a faucet, which makes the loop
     * below vacuous rather than satisfied. */
    expect(noFaucet.length).toBeGreaterThan(0);
    for (const id of noFaucet) {
      /* RED WHEN a faucet is invented for a network whose record says it has
       * none. `null` is an answer, and turning it into a url is this table
       * saying something the record does not. */
      expect(ENDPOINTS[id]!.faucetUrl, id).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(ENDPOINTS[id]!, 'faucetUrl'), id).toBe(false);
    }
  });

  it('knows stagenet is on shielded.tools, not midnight.network', () => {
    const e = ENDPOINTS.stagenet!;
    expect(e.indexerUrl).toBe('https://indexer.stagenet.shielded.tools/api/v4/graphql');
    expect(e.nodeUrl).toBe('https://rpc.stagenet.shielded.tools');
    expect(e.nodeWsUrl).toBe('wss://rpc.stagenet.shielded.tools');
    expect(e.faucetUrl).toBe('https://faucet.stagenet.shielded.tools');
  });

  it('THE ENDPOINTS TABLE IS THE RECORDS AND NOT A SECOND COPY OF THEM', () => {
    /*
     * RED WHEN the table is written out again beside the records. It is
     * derived, so a network with a record and no endpoints is absent from it
     * and every network in it is a network with a record.
     */
    for (const id of Object.keys(ENDPOINTS)) {
      expect(isNetworkId(id), id).toBe(true);
      expect(networkRecord(id).endpoints, id).not.toBeNull();
    }
    for (const id of NETWORK_IDS) {
      expect(Object.prototype.hasOwnProperty.call(ENDPOINTS, id), id)
        .toBe(networkRecord(id).endpoints !== null);
    }
  });

  it('a network with a record and no endpoints is named, refused and not invented', () => {
    const unreachable = NETWORK_IDS.filter(id => networkRecord(id).endpoints === null);
    /*
     * RED WHEN every network becomes reachable, which would make the two
     * assertions below vacuous rather than passing.
     */
    expect(unreachable.length).toBeGreaterThan(0);
    for (const id of unreachable) {
      /* RED WHEN a missing endpoint is defaulted to somebody else's host. */
      expect(() => endpointsOf(id), id).toThrow(/has no endpoints recorded/);
      expect(ENDPOINTS[id], id).toBeUndefined();
      /* And it is still a network we can name and still says what kind it is. */
      expect(networkRecord(id).id, id).toBe(id);
    }
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

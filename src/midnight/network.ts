import { NETWORK as WALLET_NETWORK } from 'midnight-identity/network';

/**
 * Which network we are on, and how to say so to the SDK.
 *
 * This file exists because of a bug that type-checked perfectly and could never
 * have worked. providers.ts did:
 *
 *     setNetworkId(ledger.NetworkId[networkIdName(cfg.networkId)])
 *
 * `ledger.NetworkId` is a numeric enum, so that passes a NUMBER. But
 * `midnight-js-network-id` declares `type NetworkId = string`, and the network
 * id is not a flag: it is interpolated verbatim as a segment of every bech32m
 * address the SDK encodes and decodes.
 *
 *     setNetworkId('testnet')  ->  mn_shield-cpk_testnet1qurswpc8...
 *     setNetworkId(2)          ->  mn_shield-cpk_21qurswpc8...
 *
 * Consequences, both executed and observed rather than reasoned about:
 *
 *   - With MIDNIGHT_NETWORK_ID=testnet, every deploy and every call throws
 *     "Expected 2 address, got testnet one" from parseCoinPublicKeyToHex,
 *     which midnight-js-contracts calls on every single transaction.
 *   - With MIDNIGHT_NETWORK_ID=undeployed the enum is 0, and bech32m refuses
 *     the character outright: "Segment network: 0 contains disallowed
 *     characters".
 *
 * The `as any` on the ledger import is what hid it from tsc.
 *
 * The authority for the correct form is the Foundation's own testkit-js@4.1.1,
 * in node_modules, which does exactly this:
 *
 *     case 'preview': setNetworkId('preview'); break;
 *     case 'preprod': setNetworkId('preprod'); break;
 *     case 'qanet':   setNetworkId('qanet');   break;
 *     default:        setNetworkId('undeployed');
 *
 * Lowercase name strings. Never the enum.
 *
 * network.test.ts proves both halves of this: that the old form fails and the
 * new form round-trips. Do not "tidy" this into the enum.
 */

/**
 * The networks the toolchain knows about.
 *
 * `stagenet` used to be rejected here, on the reasoning that testkit-js@4.1.1
 * ships configs only for preview, preprod and qanet, so the name must be a
 * loose way of saying "a staging network". That was a correct reading of the
 * wrong source. Stagenet is a real, separate chain with its own genesis at
 * `stagenet.shielded.tools`, and the Foundation's guidance is to build on it.
 *
 *
 * It is still not a network testkit has a class for — see `STAGENET_ONLY_VIA_ENV`
 * below — but it is a perfectly good network id, and the id is what goes into
 * every address.
 */
export const NETWORKS = ['undeployed', 'devnet', 'preview', 'preprod', 'qanet', 'stagenet', 'testnet', 'mainnet'] as const;

export type NetworkName = (typeof NETWORKS)[number];

export const isNetworkName = (s: string): s is NetworkName =>
  (NETWORKS as readonly string[]).includes(s);

export interface NetworkEndpoints {
  indexerUrl: string;
  indexerWsUrl: string;
  nodeUrl: string;
  /** Only where it differs from `nodeUrl` with the scheme swapped. */
  nodeWsUrl?: string;
  /** Where to ask for test NIGHT. Absent on networks that have no faucet. */
  faucetUrl?: string;
}

/**
 * Endpoints, copied from testkit-js@4.1.1 in node_modules rather than from the
 * docs site or the GitHub repo, both of which are ahead of what npm publishes.
 *
 * Note the indexer path is /api/v4/graphql. Our .env.example said v1, which is
 * a version that no longer answers.
 */
export const ENDPOINTS: Partial<Record<NetworkName, NetworkEndpoints>> = {
  preview: {
    indexerUrl: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWsUrl: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    nodeUrl: 'https://rpc.preview.midnight.network',
    faucetUrl: 'https://faucet.preview.midnight.network/api/drips',
  },
  preprod: {
    indexerUrl: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWsUrl: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    nodeUrl: 'https://rpc.preprod.midnight.network',
    faucetUrl: 'https://faucet.preprod.midnight.network/api/drips',
  },
  qanet: {
    indexerUrl: 'https://indexer.qanet.midnight.network/api/v4/graphql',
    indexerWsUrl: 'wss://indexer.qanet.midnight.network/api/v4/graphql/ws',
    nodeUrl: 'https://rpc.qanet.midnight.network',
    faucetUrl: 'https://faucet.qanet.midnight.network/api/drips',
  },
  /*
   * Stagenet. Not from testkit — it has no config for this network — but from
   * the Foundation's Q2 2026 beta delivery document, which is the only place
   * these are published.
   *
   * Note the domain: shielded.tools, not midnight.network.
   */
  stagenet: {
    indexerUrl: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
    indexerWsUrl: 'wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws',
    nodeUrl: 'https://rpc.stagenet.shielded.tools',
    nodeWsUrl: 'wss://rpc.stagenet.shielded.tools',
    faucetUrl: 'https://faucet.stagenet.shielded.tools',
  },
  undeployed: {
    indexerUrl: 'http://localhost:8088/api/v4/graphql',
    indexerWsUrl: 'ws://localhost:8088/api/v4/graphql/ws',
    nodeUrl: 'http://localhost:9944',
  },
};

/**
 * Networks testkit-js ships a TestEnvironment class for.
 *
 * Checked against testkit-js@5.0.0-beta.4 by listing its exports: Preview,
 * Preprod, Qanet, Local and EnvVar. There is no Stagenet class, in 4.1.1 or in
 * 5.0. Anything not in this list has to go through the environment-variable
 * route, which is a supported path rather than a workaround.
 */
export const TESTKIT_ENVIRONMENTS = ['preview', 'preprod', 'qanet'] as const;

export const hasTestkitEnvironment = (name: NetworkName): boolean =>
  (TESTKIT_ENVIRONMENTS as readonly string[]).includes(name);

/**
 * Configures `EnvVarRemoteTestEnvironment` for a network testkit has no class
 * for, by setting the variables it reads.
 *
 * The names are read out of the built testkit, not guessed:
 *   MN_TEST_NETWORK_ID, MN_TEST_WALLET_NETWORK_ID, MN_TEST_INDEXER,
 *   MN_TEST_INDEXER_WS, MN_TEST_NODE, MN_TEST_NODE_WS, MN_TEST_FAUCET
 *
 * Returns what it set, so a script can print it. Silence about which endpoints
 * a run is actually talking to is how an afternoon disappears.
 */
export function exportTestkitEnv(name: NetworkName): Record<string, string> {
  const e = ENDPOINTS[name];
  if (!e) throw new Error(`no endpoints known for "${name}"`);
  const vars: Record<string, string> = {
    MN_TEST_NETWORK_ID: name,
    MN_TEST_WALLET_NETWORK_ID: name,
    MN_TEST_INDEXER: e.indexerUrl,
    MN_TEST_INDEXER_WS: e.indexerWsUrl,
    MN_TEST_NODE: e.nodeUrl,
    MN_TEST_NODE_WS: e.nodeWsUrl ?? e.nodeUrl.replace(/^http/, 'ws'),
  };
  if (e.faucetUrl) vars.MN_TEST_FAUCET = e.faucetUrl;
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  return vars;
}

/**
 * Tells the SDK which network we are on.
 *
 * Call this exactly once, during provider assembly. Every wallet and contract
 * operation throws until it has been called, and every one of them produces a
 * wrong or rejected address if it was called with the wrong shape.
 */
export async function applyNetworkId(name: NetworkName): Promise<void> {
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId(name);
}

/** Reads and validates the network name from the environment. */
export function networkFromEnv(raw: string | undefined, fallback: NetworkName = 'preview'): NetworkName {
  if (raw === undefined || raw === '') return fallback;
  const lowered = raw.toLowerCase();
  if (!isNetworkName(lowered)) {
    throw new Error(
      `MIDNIGHT_NETWORK_ID="${raw}" is not a network this toolchain knows. ` +
        `Expected one of: ${NETWORKS.join(', ')}.`,
    );
  }
  return lowered;
}

/* ------------------- the network the two products share ------------------ */

/**
 * **THE NETWORK THIS DEPLOYMENT IS ON, AND IT IS NOT READ FROM `.env`.**
 * `docs/how-money-can-be-lost.md` `C151`.
 *
 * A person signs in with an address their wallet wrote, and this deployment
 * re-derives that address from the key that signed it. **A Midnight address is
 * bech32 and the network name is a segment of the string**, so one key produces
 * two different addresses on two networks. The wallet was `stagenet` and this
 * side was `preview`, so the comparison failed and the refusal told a person
 * their key was wrong. Nothing was wrong with the key.
 *
 * ── WHY `.env` IS THE WRONG HOME, AND IT IS `X3`'s ARGUMENT AGAIN ─────────
 *
 * `X3` gave the two origins to the development script rather than to `.env`,
 * on the reasoning that **`.env` is deployment configuration, and a file whose
 * whole purpose is to be different on every server is the wrong home for a
 * value that must be the same everywhere.** This value is stronger than that:
 * it must equal a constant COMPILED INTO ANOTHER REPOSITORY. A deployment
 * cannot be given the ability to disagree with it, because disagreeing with it
 * is the defect.
 *
 * So the value is imported from the wallet's own package — one constant, read
 * by both products, and `midnight-identity/network` is a leaf module that
 * pulls in no WebAssembly. **There is no second constant to drift.**
 *
 * The two lists of network names ARE still two — this file has one and the
 * wallet has another — and the assignment below is what checks them: if the
 * wallet ever learned a name this toolchain does not know, this line stops
 * compiling. That is a typecheck rather than a test, which is why the test
 * exists as well.
 */
export const PAIR_NETWORK: NetworkName = WALLET_NETWORK;

/**
 * What the server calls to learn its network, and **the thing that fails when
 * the two sides disagree.**
 *
 * `MIDNIGHT_NETWORK_ID` still exists, because the probes and the scripts under
 * `scripts/` read it and point at real chains. What it may no longer do is
 * DECIDE. If it names a different network from the one the wallet is compiled
 * for, this throws at boot with both values and both homes in the sentence —
 * because the alternative is a server that quietly writes every payee address
 * for a chain no wallet in this pair can read.
 *
 * Unset is not a disagreement. It is the ordinary case, and it gets the pair's
 * network.
 */
export function networkOfThePair(raw: string | undefined): NetworkName {
  if (raw === undefined || raw.trim() === '') return PAIR_NETWORK;
  const asked = networkFromEnv(raw, PAIR_NETWORK);
  if (asked !== PAIR_NETWORK) {
    throw new Error(
      `MIDNIGHT_NETWORK_ID="${raw}" disagrees with the wallet this deployment signs people `
      + `in with, which is compiled for "${PAIR_NETWORK}" (midnight-identity/network). A `
      + 'network name is part of every Midnight address, so the two would write the same '
      + `person's address two different ways and every sign-in would be refused. Set it to `
      + `"${PAIR_NETWORK}" or remove the line; changing which network this pair is on means `
      + 'changing it in the wallet.');
  }
  return PAIR_NETWORK;
}

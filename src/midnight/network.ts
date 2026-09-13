import { NETWORK as WALLET_NETWORK, NETWORKS as WALLET_NETWORKS, type NetworkName as WalletNetworkName } from 'midnight-identity/network';
import {
  NETWORK_IDS, endpointsOf, isNetworkId, networkRecord, websocketNodeOf,
  type NetworkRecord,
} from '../core/networks.js';

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
 *   - With the network named `testnet`, every deploy and every call throws
 *     "Expected 2 address, got testnet one" from parseCoinPublicKeyToHex,
 *     which midnight-js-contracts calls on every single transaction.
 *   - With the network named `undeployed` the enum is 0, and bech32m refuses
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
 * **THE NAMES THE TOOLCHAIN WILL TAKE, AND THERE IS ONLY ONE LIST OF THEM.**
 *
 * This used to be a second array written out here beside the wallet's. The two
 * agreed, and two lists that agree are one list that has not drifted yet. It is
 * re-exported from the one place it is stated so that adding a name is one
 * edit rather than two edits and a hope.
 *
 * **IT IS NOT THE SAME QUESTION AS WHETHER WE HAVE A RECORD FOR A NETWORK.**
 * This list is vocabulary: the names the platform's address codec will encode
 * without complaint. `networks.json` is the set of networks this application
 * has decided something about - where to reach them, and whether real money
 * settles on them. A name can be in the first and absent from the second, and
 * that is a network we can spell and have not written down, which is refused.
 */
export const NETWORKS = WALLET_NETWORKS;

export type NetworkName = WalletNetworkName;

export const isNetworkName = (s: string): s is NetworkName =>
  (NETWORKS as readonly string[]).includes(s);

export interface NetworkEndpoints {
  indexerUrl: string;
  indexerWsUrl: string;
  nodeUrl: string;
  nodeWsUrl: string;
  /** Where to ask for test NIGHT. Absent on networks that have no faucet. */
  faucetUrl?: string;
}

/**
 * **THE ENDPOINTS TABLE IS DERIVED FROM THE RECORDS AND IS NOT WRITTEN OUT
 * AGAIN.**
 *
 * It used to be a literal here, and that literal was the second place a
 * network was described. A network's endpoints and a network's identity are
 * one fact about one thing, and keeping them in two files is how a network
 * ends up admitted by one of them and unreachable through the other.
 *
 * A network whose record carries no endpoints is absent from this table, which
 * is the same shape the table has always had: `ENDPOINTS[name]` is undefined
 * for a network we cannot reach. What has changed is that the record still
 * exists, still says whether real money settles there, and still refuses a
 * test asset - so being unreachable is no longer what keeps an asset off a
 * chain.
 */
export const ENDPOINTS: Partial<Record<string, NetworkEndpoints>> = Object.freeze(
  Object.fromEntries(
    NETWORK_IDS
      .map((id) => [id, networkRecord(id).endpoints] as const)
      .filter((pair): pair is readonly [string, NonNullable<NetworkRecord['endpoints']>] => pair[1] !== null)
      .map(([id, e]) => [id, Object.freeze({
        indexerUrl: e.indexer,
        indexerWsUrl: e.indexerWs,
        nodeUrl: e.node,
        nodeWsUrl: websocketNodeOf(e),
        ...(e.faucet === null ? {} : { faucetUrl: e.faucet }),
      })]),
  ),
);

/**
 * Networks testkit-js ships a TestEnvironment class for.
 *
 * Checked against testkit-js@5.0.0-beta.4 by listing its exports: Preview,
 * Preprod, Qanet, Local and EnvVar. There is no Stagenet, in 4.1.1 or in
 * 5.0. Anything not in this list has to go through the environment-variable
 * route, which is a supported path rather than a workaround.
 */
export const TESTKIT_ENVIRONMENTS = ['preview', 'preprod', 'qanet'] as const;

export const hasTestkitEnvironment = (name: string): boolean =>
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
export function exportTestkitEnv(name: string): Record<string, string> {
  const e = endpointsOf(name);
  const vars: Record<string, string> = {
    MN_TEST_NETWORK_ID: name,
    MN_TEST_WALLET_NETWORK_ID: name,
    MN_TEST_INDEXER: e.indexer,
    MN_TEST_INDEXER_WS: e.indexerWs,
    MN_TEST_NODE: e.node,
    MN_TEST_NODE_WS: websocketNodeOf(e),
  };
  if (e.faucet !== null) vars.MN_TEST_FAUCET = e.faucet;
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
export async function applyNetworkId(name: string): Promise<void> {
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId(name);
}

/* ------------------- the network the two products share ------------------ */

/**
 * **THE NETWORK THIS DEPLOYMENT IS ON, AND IT IS NOT READ FROM `.env`.**
 *
 * A person signs in with an address their wallet wrote, and this deployment
 * re-derives that address from the key that signed it. **A Midnight address is
 * bech32 and the network name is a segment of the string**, so one key produces
 * two different addresses on two networks. The wallet was `stagenet` and this
 * side was `preview`, so the comparison failed and the refusal told a person
 * their key was wrong. Nothing was wrong with the key.
 *
 * ── WHY `.env` IS THE WRONG HOME ──────────────────────────────────────────
 *
 * **`.env` is deployment configuration, and a file whose whole purpose is to be
 * different on every server is the wrong home for a value that must be the same
 * everywhere.** This value is stronger than that: it must equal a constant
 * COMPILED INTO ANOTHER REPOSITORY. A deployment cannot be given the ability to
 * disagree with it, because disagreeing with it is the defect.
 *
 * So the value is imported from the wallet's own package - one constant, read
 * by both products, and `midnight-identity/network` is a leaf module that
 * pulls in no WebAssembly. **There is no second constant to drift.**
 */
export const PAIR_NETWORK: NetworkName = WALLET_NETWORK;

/**
 * **THE ONE PLACE IN THIS APPLICATION THAT READS THE ENVIRONMENT FOR A
 * NETWORK.** Nothing else may, and a test refuses the day something does.
 *
 * A door that reads the variable for itself is a second answer to a question
 * that must have one. Seven of them, each defaulting for itself, is seven
 * answers that happen to agree - and they agreed right up until an asset gate
 * asked a different one of them from the doors.
 *
 * ── THE FOUR ANSWERS, IN ORDER ────────────────────────────────────────────
 *
 * 1. The build's own network must have a record. It cannot be reached without
 *    one, and a build compiled for a network nobody has written down is a
 *    build that cannot say whether real money settles where it is pointed.
 * 2. Nothing named: the build's own network. This is the ordinary case and it
 *    is not a default - it is the answer, taken from the one constant both
 *    products are compiled against.
 * 3. A name with no record: **REFUSED, LOUDLY, WITH THE NAMES THAT DO HAVE
 *    ONE.** There is no fallback. A network nobody has thought of is refused
 *    by default rather than admitted by default, and that is the whole
 *    difference between this and a list of networks that are forbidden.
 * 4. A name that has a record but is not the build's own: **REFUSED**, with
 *    both values and both homes in the sentence, because the alternative is a
 *    deployment quietly writing every payee address for a chain no wallet in
 *    this pair can read.
 */
export function theNetwork(env: { MIDNIGHT_NETWORK_ID?: string | undefined } = process.env): NetworkName {
  return theNetworkNamed(env.MIDNIGHT_NETWORK_ID, PAIR_NETWORK);
}

/**
 * The four answers above, as a function of the two values they are about.
 *
 * **THE ENVIRONMENT IS READ IN EXACTLY ONE PLACE AND THE RULES ARE DECIDED IN
 * ANOTHER**, so every one of these refusals can be DRIVEN. The first of them -
 * a build compiled for a network with no record - cannot otherwise be watched
 * refusing at all: the constant it is about is compiled into another package on
 * purpose, and a way to vary it would be the override this whole design exists
 * to remove.
 */
export function theNetworkNamed(raw: string | undefined, pair: string): NetworkName {
  const PAIR_NETWORK = pair as NetworkName;
  if (!isNetworkId(PAIR_NETWORK)) {
    throw new Error(
      `this build is compiled for "${PAIR_NETWORK}" and there is no record for that network. The `
      + `networks with records are: ${NETWORK_IDS.join(', ')}. Add the record, or build for a `
      + 'network that has one; nothing here will proceed without knowing whether real money '
      + 'settles where it is pointed.');
  }
  if (raw === undefined || raw.trim() === '') return PAIR_NETWORK;
  const asked = raw.trim();
  if (!isNetworkId(asked)) {
    throw new Error(
      `MIDNIGHT_NETWORK_ID="${raw}" names no network this application has a record for. The `
      + `networks it has records for are: ${NETWORK_IDS.join(', ')}. There is no default and no `
      + 'fallback: a name nobody has written a record for is refused rather than guessed at, '
      + 'because a guess is a deployment silently on a network nobody asked for.');
  }
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

/** The whole record for the network this run is on, resolved the one way there is. */
export const theNetworkRecord = (
  env?: { MIDNIGHT_NETWORK_ID?: string | undefined },
): NetworkRecord => networkRecord(theNetwork(env));

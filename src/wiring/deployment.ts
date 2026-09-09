/**
 * WHERE A DEPLOYMENT'S FACTS COME FROM, AND THE ONLY PLACE THEY COME FROM.
 *
 * A chain wiring needs four things the simulated one never needed: which
 * network, which deployed contract, which indexer, which proof server. Each of
 * them already had somewhere it could be read from before this file existed,
 * and that is the problem this file is answering rather than a convenience it
 * is adding.
 *
 * ── WHY ONE PLACE, STATED AS THE FAILURE IT PREVENTS ─────────────────────
 *
 * `src/midnight/ledger.ts` requires its commitment scheme with no default, and
 * says why: a default is a SECOND PLACE THE ANSWER CAN COME FROM. The same
 * argument applies with more force to a contract address. A product that can
 * read an address from two places will one day read the two differently — and
 * the failure is not a crash. It is a screen that shows an account's real
 * balance beside another deployment's proposals, or a round raised against a
 * contract nobody is watching. **Nothing goes wrong loudly; the numbers are
 * just about a different account.**
 *
 * So every fact below has exactly one home and this module is it:
 *
 *     network           the pair's network, through `networkOfThePair`, which
 *                       already refuses when the wallet and the server disagree.
 *                       NOT re-read from the deployment record, which is
 *                       CHECKED against it instead.
 *     contract address  the deployment record on disk, and nowhere else. There
 *                       is deliberately no environment variable and no literal:
 *                       an address is written by a deploy and read by everything
 *                       afterwards, and a second way to say it is a second
 *                       deployment nobody declared.
 *     indexer, node     the endpoint table, keyed by the network name above, so
 *                       the two cannot name different chains.
 *     proof server      required, with no default. See `proverUrl` below.
 *
 * ── WHY THE RECORD IS NOT ALSO THE NETWORK ───────────────────────────────
 *
 * The record carries a `network` field, so it is a candidate second home for
 * the network name. It is used as a CHECK and never as a source: if the record
 * on disk was written for a different chain from the one this deployment signs
 * people in with, that is the one case where reading either value and
 * proceeding is wrong, and the refusal below says both.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENDPOINTS, networkOfThePair, type NetworkName } from '../midnight/network.js';

/**
 * The facts, resolved. Every field is present or this object does not exist —
 * there is no partially-configured deployment, because a partially-configured
 * deployment is one that reads the missing half from somewhere else.
 */
export interface Deployment {
  readonly network: NetworkName;
  readonly contractAddress: string;
  readonly indexerUrl: string;
  readonly indexerWsUrl: string;
  readonly nodeUrl: string;
  readonly proverUrl: string;
  /**
   * Where sealed blobs live, **and the network is in the path**.
   *
   * Not tidiness. A blob is filed under the account id and a commitment, and
   * that commitment is one constant for every account and every state. Two
   * deployments on two chains sharing a root therefore collide on one filename
   * for one account — and the store leaves an existing file alone, on the
   * correct reasoning that a commitment is a hash of the state. So the second
   * chain's blob would not be written, no error would be raised, and the first
   * chain's ciphertext would be served as this account's state.
   */
  readonly sealedStateRoot: string;
  /** The private-state store's key. Per network — one deployment's private
   *  state read on another chain is a witness computed against the wrong
   *  contract. */
  readonly privateStateId: string;
  /** The compiled circuit assets the proof server is given. */
  readonly zkConfigPath: string;
}

/** What a deploy writes, of which this module reads two fields. */
interface DeploymentRecord {
  network?: unknown;
  contractAddress?: unknown;
}

export const deploymentRecordPath = (root: string, network: NetworkName): string =>
  join(root, '.midnight', `${network}-contract.json`);

/**
 * **THE RULES, SEPARATED FROM THE READING, SO THEY CAN BE TESTED WITHOUT A
 * DISK.** Everything that can refuse is here and takes plain values; the
 * exported reader below does the I/O and then calls this. A rule that can only
 * be exercised by arranging a filesystem is a rule that gets exercised once.
 */
export function resolveDeployment(input: {
  network: NetworkName;
  record: DeploymentRecord | null;
  recordPath: string;
  endpoints: { indexerUrl: string; indexerWsUrl: string; nodeUrl: string } | undefined;
  proverUrl: string | undefined;
  stateRoot: string;
  zkConfigPath: string;
}): Deployment {
  const { network, record, recordPath, endpoints, proverUrl } = input;

  if (!record) {
    throw new Error(
      `this deployment is set to run against ${network}, and the record of what was `
      + `deployed there is not at ${recordPath}. That file is written by the deploy `
      + 'and read by everything afterwards; until a contract has been deployed to '
      + `${network} and its address recorded, there is nothing for the product to talk to.`);
  }

  if (typeof record.network !== 'string' || record.network !== network) {
    throw new Error(
      `the deployment record at ${recordPath} was written for `
      + `"${String(record.network)}", and this deployment signs people in on "${network}". `
      + 'A network name is part of every address on both sides, so proceeding would read '
      + 'one chain\'s contract while writing the other chain\'s addresses. Deploy to '
      + `"${network}" and record it, or run this deployment on "${String(record.network)}".`);
  }

  const address = record.contractAddress;
  if (typeof address !== 'string' || address.trim() === '') {
    throw new Error(
      `the deployment record at ${recordPath} carries no contract address. A record `
      + 'without one is a deploy that did not finish; there is deliberately no other '
      + 'place to put the address, because a second place is a second deployment.');
  }

  if (!endpoints) {
    throw new Error(
      `no indexer and node are known for "${network}". The endpoint table is keyed by `
      + 'the network this deployment is compiled for, so a network with no entry cannot '
      + 'be reached at all rather than reached at a guess.');
  }

  /*
   * **REQUIRED, WITH NO DEFAULT, AND THIS IS THE ONE MOST LIKELY TO BE ARGUED
   * WITH.** Every other consumer in this repository defaults the proof server
   * to a local port, which is right for a script somebody is watching and wrong
   * for a server. A defaulted prover is a deployment that comes up believing it
   * can prove, and finds out otherwise at the first round somebody raises —
   * after the money question has already been asked.
   */
  if (proverUrl === undefined || proverUrl.trim() === '') {
    throw new Error(
      'no proof server is configured, and there is deliberately no default. Set '
      + 'MIDNIGHT_PROVER_URL to the proof server this deployment should use. It is '
      + 'required rather than assumed because a deployment that guesses wrong comes up '
      + 'looking healthy and fails at the first round anybody raises.');
  }

  return {
    network,
    contractAddress: address,
    indexerUrl: endpoints.indexerUrl,
    indexerWsUrl: endpoints.indexerWsUrl,
    nodeUrl: endpoints.nodeUrl,
    proverUrl,
    sealedStateRoot: join(input.stateRoot, '.midnight', 'sealed', network),
    privateStateId: `confidential-accounts-${network}`,
    zkConfigPath: input.zkConfigPath,
  };
}

/** The reader. I/O, then the rules above. */
export function deployment(root: string, env: NodeJS.ProcessEnv = process.env): Deployment {
  const network = networkOfThePair(env.MIDNIGHT_NETWORK_ID);
  const recordPath = deploymentRecordPath(root, network);

  let record: DeploymentRecord | null = null;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8')) as DeploymentRecord;
  } catch (e: any) {
    /*
     * A missing file is the ordinary case and gets the sentence above. A file
     * that exists and cannot be parsed is a different problem and must not be
     * reported as absence — that is the same conflation the status boundary
     * refuses one layer down.
     */
    if (e?.code !== 'ENOENT') {
      throw new Error(
        `the deployment record at ${recordPath} could not be read: ${e?.message ?? e}. `
        + 'It is not missing, so this is not a deployment that has not happened; '
        + 'something has written that file badly.');
    }
  }

  return resolveDeployment({
    network,
    record,
    recordPath,
    endpoints: ENDPOINTS[network],
    proverUrl: env.MIDNIGHT_PROVER_URL,
    stateRoot: root,
    zkConfigPath: join(root, 'contracts', 'managed'),
  });
}

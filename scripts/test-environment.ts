/**
 * The testkit environment for a network, built from the network's one record.
 *
 * testkit-js ships classes of its own for some networks, each with hosts
 * written into the package and no project token, and none for others.
 * `EnvVarRemoteTestEnvironment` reads its endpoints from `MN_TEST_*` variables,
 * so every network goes through it, filled from the record by
 * `exportTestkitEnv`: one table of endpoints in the project, with a network's
 * project token joined where its record asks for one, and the same endpoints
 * for the wallets a door brings up and the readers beside them.
 *
 * Every script that brings up a wallet goes through here, so anything they all
 * do lives in one module.
 */
import { EnvVarRemoteTestEnvironment } from '@midnight-ntwrk/testkit-js';

import { shownAddress } from '../src/core/networks.js';
import { type NetworkName, exportTestkitEnv } from '../src/midnight/network.js';

export type EnvironmentChoice = {
  env: any;
  /** Which endpoints it was built with, for the log, each without its query so no project token is printed. */
  how: string;
};

/**
 * Builds a testkit environment for `network` from its record, and says which
 * endpoints it reaches: a run that names them costs one line and saves the
 * confusion of a transaction quietly going to the wrong chain.
 */
export function testEnvironmentFor(network: NetworkName, logger: unknown): EnvironmentChoice {
  const vars = exportTestkitEnv(network);
  return {
    env: new (EnvVarRemoteTestEnvironment as any)(logger),
    how:
      `"${network}", reached at the endpoints its record names:\n` +
      `      node    ${shownAddress(vars.MN_TEST_NODE!)}\n` +
      `      indexer ${shownAddress(vars.MN_TEST_INDEXER!)}` +
      (vars.MN_TEST_FAUCET ? `\n      faucet  ${shownAddress(vars.MN_TEST_FAUCET)}` : ''),
  };
}

/**
 * What a failed health check says, with the endpoint it asked named by its host
 * and path only, so a project token in the query never reaches a door's output.
 */
export function healthCheckFailure(e: any): string {
  const message = String(e?.message ?? e).split('\n')[0];
  const url = e?.config?.url;
  if (typeof url !== 'string') return message;
  let where = url.split('?')[0]!;
  try { const u = new URL(url); where = `${u.host}${u.pathname}`; } catch { /* the bare form above */ }
  return `${message}, from ${where}`;
}

/**
 * Whether a failed health check is worth asking again: a timeout, a dropped
 * connection, or a gateway answering that it is busy or that what is behind it
 * did not answer (502, 503, 504). Anything else is the network saying no.
 */
export const looksTransient = (why: string): boolean =>
  /timeout|ECONNABORTED|ECONNRESET|ETIMEDOUT|socket hang up|status code 50[234]/i.test(why);

/**
 * Starts a testkit environment, RETRYING THE HEALTH CHECK.
 *
 * `env.start()` pings the node, the indexer, the proof server and the faucet
 * with a one-second timeout written into testkit-js, which the caller cannot
 * change. Against public endpoints one second is marginal, so a slow moment
 * anywhere would end the run before it starts, saying nothing about which
 * endpoint was slow. The check is a liveness probe with no side effects, so
 * running it again is safe and a transient blip is what a retry is for; a
 * network that really is down still fails after the last attempt. Every script
 * that brings up a wallet starts its environment here, so none goes without it.
 */
export async function startEnvironment(
  env: any,
  container: unknown,
  note: (s: string) => void,
  attempts = 4,
): Promise<any> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await env.start(container);
    } catch (e: any) {
      const why = healthCheckFailure(e);
      if (attempt === attempts || !looksTransient(why)) throw new Error(why, { cause: e });
      note(`  the environment health check failed (${why}) — attempt ${attempt} of ${attempts}, retrying`);
      note('  its timeout is one second and is written into the testkit, so it cannot be raised here');
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error('unreachable');
}

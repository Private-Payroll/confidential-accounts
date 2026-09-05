/**
 * Which testkit environment to use for a given network — including networks
 * testkit has no class for.
 *
 * testkit-js ships `PreviewTestEnvironment`, `PreprodTestEnvironment`,
 * `QanetTestEnvironment`, `LocalTestEnvironment` and
 * `EnvVarRemoteTestEnvironment`. That list is the same in 4.1.1 and in
 * 5.0.0-beta.4 — checked by listing the exports of both, not by reading release
 * notes. **There is no Stagenet class**, and the Foundation's guidance is to
 * build on Stagenet.
 *
 * `EnvVarRemoteTestEnvironment` is the supported answer rather than a
 * workaround: it reads its endpoints from `MN_TEST_*` variables, which is
 * exactly the escape hatch for a network the package predates. We fill those in
 * from `src/midnight/network.ts`, so there is still one table of endpoints in
 * the project and not two.
 *
 * Both scripts go through here. The deploy and the run had already drifted
 * apart once — a sync-progress fix landed in one and not the
 * other, and that cost a deployment — so anything both of them do lives in one
 * module now.
 */
import {
  PreviewTestEnvironment,
  PreprodTestEnvironment,
  QanetTestEnvironment,
  EnvVarRemoteTestEnvironment,
} from '@midnight-ntwrk/testkit-js';

import { type NetworkName, hasTestkitEnvironment, exportTestkitEnv } from '../src/midnight/network.js';

const CLASSES: Partial<Record<NetworkName, new (logger: unknown) => unknown>> = {
  preview: PreviewTestEnvironment as never,
  preprod: PreprodTestEnvironment as never,
  qanet: QanetTestEnvironment as never,
};

export type EnvironmentChoice = {
  env: any;
  /** How it was built, for the log. Silence here is how an afternoon goes missing. */
  how: string;
};

/**
 * Builds a testkit environment for `network`.
 *
 * Deliberately not silent about which route it took. A run that says which
 * endpoints it is talking to costs one line and saves the class of confusion
 * where a transaction quietly goes to the wrong chain.
 */
export function testEnvironmentFor(network: NetworkName, logger: unknown): EnvironmentChoice {
  const Cls = CLASSES[network];
  if (Cls && hasTestkitEnvironment(network)) {
    return { env: new (Cls as any)(logger), how: `testkit's own ${network} environment` };
  }

  const vars = exportTestkitEnv(network);
  return {
    env: new (EnvVarRemoteTestEnvironment as any)(logger),
    how:
      `no testkit class for "${network}", so its endpoints were supplied directly:\n` +
      `      node    ${vars.MN_TEST_NODE}\n` +
      `      indexer ${vars.MN_TEST_INDEXER}` +
      (vars.MN_TEST_FAUCET ? `\n      faucet  ${vars.MN_TEST_FAUCET}` : ''),
  };
}

/**
 * Starts a testkit environment, RETRYING THE HEALTH CHECK. M-116, moved here by M-137.
 *
 * `env.start()` pings the node, the indexer, the proof server and the faucet
 * with `axios … { timeout: 1000 }`. The value is hardcoded in four places in
 * `testkit-js`, so it cannot be configured from the caller. Against public
 * internet endpoints one second is marginal by design — the run that worked
 * measured 500ms, 670ms and 870ms — so a slow moment anywhere kills the run
 * before it starts, with `AxiosError: timeout of 1000ms exceeded` and nothing
 * to say which endpoint was slow.
 *
 * A retry is the right shape rather than a workaround. The check is a liveness
 * probe with no side effects, so running it again costs a second and is safe by
 * construction, and a transient blip is exactly what a retry is for. If the
 * network really is down, four attempts say so just as clearly.
 *
 * IT LIVES HERE BECAUSE THE DEPLOY DID NOT HAVE IT. `run-preview.ts` carried
 * this loop and `deploy-preview.ts` called `env.start` bare, against the same
 * four endpoints on the same network — so the script that must succeed FIRST
 * was the one without the protection. That is the drift this module's own
 * header says it exists to prevent, in the module that says it.
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
      const why = String(e?.message ?? e).split('\n')[0];
      const looksTransient = /timeout|ECONNABORTED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(why);
      if (attempt === attempts || !looksTransient) throw e;
      note(`  the environment health check failed (${why}) — attempt ${attempt} of ${attempts}, retrying`);
      note('  its timeout is one second and is hardcoded in the testkit; see M-116');
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error('unreachable');
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NETWORK_IDS, endpointsOf, networkRecord, websocketNodeOf } from '../src/core/networks.js';
import type { NetworkName } from '../src/midnight/network.js';
import { healthCheckFailure, looksTransient, startEnvironment, testEnvironmentFor } from './test-environment.js';

const TOKEN = 'aProjectToken42';
const reachable = NETWORK_IDS.filter((id) => networkRecord(id).endpoints !== null);

afterEach(() => { vi.unstubAllEnvs(); });

describe('the environment every door and the run path reach a network through', () => {
  it('IS THE NETWORK\'S RECORD, PROJECT TOKEN INCLUDED, FOR EVERY NETWORK THE RECORD SERVES', () => {
    for (const id of reachable) {
      const token = networkRecord(id).endpoints!.projectToken;
      if (token !== null) vi.stubEnv(token.setting, TOKEN);
      const e = endpointsOf(id);
      const config = testEnvironmentFor(id as NetworkName, console).env.getEnvironmentConfiguration();
      /* RED WHEN a door or the run path reaches a network at hosts the record does not name - a testkit
       * class's own hosts, with no project token - while the readers beside it use the record. */
      expect({ networkId: config.networkId, node: config.node, nodeWS: config.nodeWS, indexer: config.indexer,
        indexerWS: config.indexerWS, faucet: config.faucet ?? null }, id).toEqual({
        networkId: id, node: e.node, nodeWS: websocketNodeOf(e), indexer: e.indexer, indexerWS: e.indexerWs,
        faucet: e.faucet,
      });
    }
  });

  it('a network that asks for no project token is reached exactly as its record writes it', () => {
    for (const id of reachable.filter((n) => networkRecord(n).endpoints!.projectToken === null)) {
      const recorded = networkRecord(id).endpoints!;
      const config = testEnvironmentFor(id as NetworkName, console).env.getEnvironmentConfiguration();
      /* RED WHEN stagenet, or any network reached without a token, moves as a side effect of reaching
       * every network through its record. */
      expect([config.node, config.nodeWS, config.indexer, config.indexerWS], id)
        .toEqual([recorded.node, websocketNodeOf(recorded), recorded.indexer, recorded.indexerWs]);
    }
  });

  it('PRINTS EACH ENDPOINT WITHOUT ITS QUERY, SO NO PROJECT TOKEN REACHES A DOOR\'S OUTPUT', () => {
    for (const id of reachable.filter((n) => networkRecord(n).endpoints!.projectToken !== null)) {
      vi.stubEnv(networkRecord(id).endpoints!.projectToken!.setting, TOKEN);
      const { how } = testEnvironmentFor(id as NetworkName, console);
      /* RED WHEN the line a door prints names an endpoint with the token joined to it. */
      expect(how, id).not.toContain(TOKEN);
      expect(how, id).toContain(new URL(endpointsOf(id).indexer).host);
    }
  });
});

describe('the health check a run starts with', () => {
  it('asks again when a gateway is busy, and not when it refuses', () => {
    /* RED WHEN a 503 from a provider ends a run on its first answer, or a 403 is asked again. */
    for (const busy of ['Request failed with status code 503', 'Request failed with status code 502',
      'Request failed with status code 504', 'timeout of 1000ms exceeded']) expect(looksTransient(busy), busy).toBe(true);
    for (const no of ['Request failed with status code 403', 'Request failed with status code 404'])
      expect(looksTransient(no), no).toBe(false);
  });

  it('names the endpoint that failed, without its query, so no project token is printed', () => {
    const e = Object.assign(new Error('Request failed with status code 503'),
      { config: { url: `https://midnight-preprod.example/api/v0/ready?project_id=${TOKEN}` } });
    const why = healthCheckFailure(e);
    /* RED WHEN the failure names no endpoint, or names it with the token. */
    expect(why).toBe('Request failed with status code 503, from midnight-preprod.example/api/v0/ready');
    expect(why).not.toContain(TOKEN);
  });

  it('retries a busy answer and returns once one attempt passes', async () => {
    let calls = 0;
    const env = { start: async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('Request failed with status code 503'), { config: { url: 'https://x.example/health' } });
      return 'started';
    } };
    vi.useFakeTimers();
    const notes: string[] = [];
    const run = startEnvironment(env, null, (s) => notes.push(s));
    await vi.runAllTimersAsync();
    /* RED WHEN a 503 is thrown on the first attempt. */
    await expect(run).resolves.toBe('started');
    vi.useRealTimers();
    expect(calls).toBe(3);
    expect(notes.join('\n')).toContain('x.example/health');
  });

  it('stops at once on a refusal, naming where it came from', async () => {
    let calls = 0;
    const env = { start: async () => {
      calls += 1;
      throw Object.assign(new Error('Request failed with status code 403'), { config: { url: `https://y.example/ready?project_id=${TOKEN}` } });
    } };
    const run = startEnvironment(env, null, () => undefined);
    await expect(run).rejects.toThrow('Request failed with status code 403, from y.example/ready');
    expect(calls).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as keyring from './keyring.js';
import { ReadRanOutOfTime, SERVICE_READ_BOUND_MS } from './read-bound.js';
import { manifestServiceOf, serviceSource, treeServiceOf } from './records-source.js';
import * as transport from './service-transport.js';
import { accountPresenceAt } from './vault-on-chain-here.js';
import { ASK_STARTED, vaultBuilderOver } from './vault-worker-client.js';

// A read that never answers ends at twenty seconds, with words, and is aborted; a send is never cut short.
// RED WHEN: a read ends before or after twenty seconds, ends unaborted or without words saying what did not answer; or a send ends at twenty seconds.
const signals: (AbortSignal | undefined)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  signals.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise<Response>((_, refuse) => {
          signals.push(init?.signal ?? undefined);
          init?.signal?.addEventListener('abort', () => {
            refuse(new DOMException('aborted', 'AbortError'));
          });
        })
    )
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  keyring.forgetLocally();
});

const settle = <T>(p: Promise<T>) => {
  const state: { done: boolean; error?: unknown } = { done: false };
  p.then(
    () => {
      state.done = true;
    },
    (e: unknown) => {
      state.done = true;
      state.error = e;
    }
  );
  return state;
};

async function endsAtTheBound(start: () => Promise<unknown>, what: RegExp) {
  const before = signals.length;
  const state = settle(start());
  await vi.advanceTimersByTimeAsync(SERVICE_READ_BOUND_MS - 1);
  expect(state.done).toBe(false);
  expect(signals.slice(before).some((s) => s?.aborted === true)).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.done).toBe(true);
  expect(state.error).toBeInstanceOf(ReadRanOutOfTime);
  expect(state.error).toHaveProperty('message', expect.stringMatching(/did not answer within 20 seconds/));
  expect(state.error).toHaveProperty('message', expect.stringMatching(what));
}

describe('reads of the service', () => {
  const tree = treeServiceOf(serviceSource(transport.api, 'acc1'));
  const manifest = manifestServiceOf(serviceSource(transport.api, 'acc1'));

  it('the entries not yet anchored (manifest/tree/pending) end at twenty seconds and the request is aborted', async () => {
    await endsAtTheBound(() => tree.pending('acc1', 'aa'), /manifest\/tree\/pending/);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('the headers page (manifest/tree/headers) ends at twenty seconds and the request is aborted', async () => {
    await endsAtTheBound(() => tree.headersAfter('acc1', 0, 10), /manifest\/tree\/headers/);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('the proofs (manifest/tree/proofs), a POST that only reads, end at twenty seconds and the request is aborted', async () => {
    await endsAtTheBound(() => tree.proofs('acc1', { root: 'aa', records: [], kinds: [] }), /manifest\/tree\/proofs/);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('the newest versions entered (manifest/newest), a POST that only reads, end at twenty seconds and the request is aborted', async () => {
    await endsAtTheBound(() => manifest.newest('acc1', [{ store: 'company', kind: 'k', id: 'i' }]), /manifest\/newest/);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('the creation standing, the call state and the company itself end at twenty seconds and are aborted', async () => {
    await endsAtTheBound(() => transport.api('/api/accounts/acc1/creation'), /creation/);
    await endsAtTheBound(() => transport.api('/api/accounts/acc1/call-state'), /call-state/);
    await endsAtTheBound(() => transport.api('/api/accounts/acc1'), /acc1/);
    expect(signals.every((s) => s?.aborted === true)).toBe(true);
  });

  it('a read that answers in time is not cut and its timer is let go', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => new Response('{"ok":true}', { status: 200 }));
    await expect(transport.api('/api/accounts/acc1/creation')).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('reads of the network', () => {
  it('the indexer read of whether the account is on the chain ends at twenty seconds and the request is aborted', async () => {
    await endsAtTheBound(() => accountPresenceAt('https://indexer.example/graphql', 'ab'), /indexer/);
    expect(signals[0]?.aborted).toBe(true);
  });

  // A worker whose code is loaded: it says it has started each ask as it is posted, then answers nothing.
  const hanging = () => {
    const posted: { id: number }[] = [];
    let hear: (data: unknown) => void = () => undefined;
    const worker = {
      postMessage: (m: { id: number }) => {
        posted.push(m);
        hear({ kind: ASK_STARTED, started: m.id });
      },
      addEventListener: (_t: 'message', l: (e: { data: unknown }) => void) => {
        hear = (data) => l({ data });
      }
    };
    return { client: vaultBuilderOver(worker, 'undeployed'), posted, hear: (d: unknown) => hear(d) };
  };
  const indexer = { indexerUri: 'https://i.example/graphql', indexerWsUri: 'wss://i.example/ws' };

  it('each read the vault worker makes of the chain ends at twenty seconds', async () => {
    const { client } = hanging();
    await endsAtTheBound(() => client.vaultOnChain({ vault: 'aa', indexer }), /vault-on-chain/);
    await endsAtTheBound(() => client.accountCallChain({ account: 'bb', indexer }), /account-call-chain/);
    await endsAtTheBound(
      () => client.accountPresence!({ account: 'bb', indexer, transactions: [] }),
      /account-presence/
    );
    await endsAtTheBound(() => client.chainAtOneBlock({ vault: 'aa', account: 'bb', indexer }), /chain-at-one-block/);
    await endsAtTheBound(() => client.eventsOf({ transactionHash: 'cc', indexer }), /events-of/);
    await endsAtTheBound(() => client.createdBy({ vault: 'aa', commitment: 'dd', indexer }), /created-by/);
    await endsAtTheBound(() => client.anchorsOnChain({ account: 'bb', indexer }), /anchors-on-chain/);
    await endsAtTheBound(() => client.roundsOnChain({ account: 'bb', indexer, chainIds: [] }), /rounds-on-chain/);
    await endsAtTheBound(
      () => client.vaultAsDeployed!({ vault: 'aa', account: 'bb', holders: { committee: [], threshold: 1 }, indexer }),
      /vault-as-deployed/
    );
  });

  it('a late answer to a read that ran out of time is let go, and the next read still answers', async () => {
    const { client, posted, hear } = hanging();
    const first = settle(client.vaultOnChain({ vault: 'aa', indexer }));
    await vi.advanceTimersByTimeAsync(SERVICE_READ_BOUND_MS);
    expect(first.done).toBe(true);
    const id = posted[0]?.id;
    hear({ id, ok: true, ask: 'vault-on-chain', read: { onChain: false } });
    const next = client.vaultOnChain({ vault: 'aa', indexer });
    await vi.advanceTimersByTimeAsync(0);
    const nextId = posted[1]?.id;
    hear({ id: nextId, ok: true, ask: 'vault-on-chain', read: { onChain: false } });
    await expect(next).resolves.toEqual({ onChain: false });
  });
});

describe('sends', () => {
  it('a send to the service is not aborted and does not end at twenty seconds', async () => {
    const state = settle(transport.api('/api/accounts/acc1/creation/pay-key', { method: 'POST', body: '{}' }));
    await vi.advanceTimersByTimeAsync(SERVICE_READ_BOUND_MS * 5);
    expect(state.done).toBe(false);
    expect(signals).toEqual([undefined]);
  });

  it('a creation send and a vault deploy by the worker do not end at twenty seconds', async () => {
    const worker = { postMessage: () => undefined, addEventListener: () => undefined };
    const client = vaultBuilderOver(worker, 'undeployed');
    const deploy = settle(client.deploy('bb'));
    const created = settle(
      client.accountDeploy!({ foundingLeaf: 'a', label: 'b', foundingKey: { tag: 't', value: 'v' } })
    );
    await vi.advanceTimersByTimeAsync(SERVICE_READ_BOUND_MS * 5);
    expect(deploy.done).toBe(false);
    expect(created.done).toBe(false);
  });
});

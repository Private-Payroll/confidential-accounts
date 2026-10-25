import { describe, expect, it } from 'vitest';
import { accountBuilding, type BuilderWorkerLike } from './account-builder-client.js';

/*
 * The wallet's way to its account builder, over a worker that behaves as a browser's does: a message that reaches it
 * before it listens is lost, and one that fails to load, never starts or never answers ends what waits on it.
 */

type Heard = (e: { data?: unknown; message?: string }) => void;

/** A builder worker: listening after `startsAfterMs` (or never), answering each ask after `answersAfterMs` (or never). */
const aBuilder = (o: { startsAfterMs?: number | null; answersAfterMs?: number | null; failsToLoad?: string } = {}) => {
  const heard: Record<string, Heard[]> = { message: [], error: [], messageerror: [] };
  const posted: unknown[] = [];
  let listening = false;
  let terminated = false;
  const tell = (type: string, e: { data?: unknown; message?: string }) => { for (const l of heard[type] ?? []) l(e); };
  const worker: BuilderWorkerLike = {
    postMessage: (m) => {
      posted.push(m);
      if (!listening || o.answersAfterMs === null) return;
      const ask = m as { id: number; ask: string };
      setTimeout(() => tell('message', { data: { id: ask.id, ok: true, ask: ask.ask, tx: 'VFg=' } }), o.answersAfterMs ?? 0);
    },
    addEventListener: (type: string, l: Heard) => { heard[type]!.push(l); },
    terminate: () => { terminated = true; },
  } as BuilderWorkerLike;
  if (o.failsToLoad !== undefined) setTimeout(() => tell('error', { message: o.failsToLoad }), 5);
  else if (o.startsAfterMs !== null) {
    setTimeout(() => { listening = true; tell('message', { data: { kind: 'account-builder-ready' } }); }, o.startsAfterMs ?? 0);
  }
  return { worker, posted, terminated: () => terminated };
};

const ASK = { ask: 'finished-creation', network: 'undeployed', account: 'ab'.repeat(32), signature: { tag: 's', value: 'v' }, verifiers: [] } as const;
const LIMITS = { startsWithinMs: 200, answersWithinMs: 200 };

describe('the wallet\'s account builder, asked from an action', () => {
  it('an ask made while the builder is still loading is posted once it listens, and answered', async () => {
    // RED WHEN: the first ask is posted before the builder listens, so it is lost and the action waits for ever with nothing sent
    const b = aBuilder({ startsAfterMs: 50 });
    const answer = await accountBuilding(() => b.worker, LIMITS)(ASK as never);
    expect(answer).toMatchObject({ ok: true, ask: 'finished-creation' });
    expect(b.posted).toHaveLength(1);
  });

  it('a builder that fails to load ends the ask with words that say so, and the next ask starts another', async () => {
    // RED WHEN: a builder that failed to load is not heard, so the action waits for ever with nothing sent
    const made: Array<ReturnType<typeof aBuilder>> = [];
    const kinds = [{ failsToLoad: 'SyntaxError in the builder' }, {}];
    const build = accountBuilding(() => { const b = aBuilder(kinds[made.length]); made.push(b); return b.worker; }, LIMITS);
    await expect(build(ASK as never)).rejects.toThrow(/account builder stopped \(SyntaxError in the builder\), so nothing was built or sent/u);
    expect(made[0]!.posted).toEqual([]);
    expect(await build(ASK as never)).toMatchObject({ ok: true });
  });

  it('a builder that never says it listens ends the ask when its time to start runs out', async () => {
    // RED WHEN: a builder that never starts is waited on for ever
    const b = aBuilder({ startsAfterMs: null });
    await expect(accountBuilding(() => b.worker, LIMITS)(ASK as never)).rejects.toThrow(/did not start within 0 seconds, so nothing was built or sent/u);
    expect(b.terminated()).toBe(true);
  });

  it('an ask that proves nothing and is never answered ends when its time runs out, and the builder is let go', async () => {
    // RED WHEN: an ask the builder never answers is waited on for ever
    const b = aBuilder({ answersAfterMs: null });
    await expect(accountBuilding(() => b.worker, LIMITS)(ASK as never)).rejects.toThrow(/did not answer within 0 seconds, so nothing was built or sent/u);
    expect(b.terminated()).toBe(true);
  });
});

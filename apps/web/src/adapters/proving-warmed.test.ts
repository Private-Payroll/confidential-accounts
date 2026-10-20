import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * THE PROVING FILES, FETCHED QUIETLY RIGHT AFTER SIGN-IN, over a vault worker
 * stood in for: the page starts its one builder, has it fetch and check the
 * files once, and says nothing to the person when that fails.
 */
const w = vi.hoisted(() => ({ worker: {} as Record<string, unknown>, starts: 0, fails: false }));
vi.mock('vaults-web-shared/vault-worker-client.js', () => ({ startVaultBuilder: async () => { w.starts += 1; if (w.fails) throw new Error('the builder did not start'); return w.worker; } }));

const aWorker = (): Record<string, unknown> => ({});
async function load() {
  vi.resetModules();
  return import('./proving-warmed.js');
}
beforeEach(() => { w.worker = aWorker(); w.starts = 0; w.fails = false; });

describe('warming the proving files', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  /*
   * RED WHEN: a person signing in twice, or two screens asking, start a second
   * builder or ask for the files a second time while they are held or on the way.
   */
  it('starts the one builder and asks for the files once, however often it is called', async () => {
    let asked = 0;
    w.worker = { ...aWorker(), provingWarmed: async () => { asked += 1; } };
    const m = await load();
    m.warmTheProving(); m.warmTheProving();
    await settle();
    m.warmTheProving();
    await settle();
    expect([w.starts, asked]).toEqual([1, 1]);
  });

  /*
   * RED WHEN: a builder that cannot fetch the files, or a worker that cannot
   * start, leaves the page with an error nobody handles.
   */
  it('says nothing when the files could not be fetched, and asks again at the next call', async () => {
    let asked = 0;
    w.worker = { ...aWorker(), provingWarmed: async () => { asked += 1; throw new Error('the public parameters did not arrive'); } };
    const m = await load();
    expect(m.warmTheProving()).toBeUndefined();
    await settle();
    m.warmTheProving();
    await settle();
    expect(asked).toBe(2);
  });

  it('says nothing when the builder does not start, and starts it again at the next call', async () => {
    w.fails = true;
    const m = await load();
    m.warmTheProving();
    await settle();
    m.warmTheProving();
    await settle();
    expect(w.starts).toBe(2);
  });

  /*
   * RED WHEN: warming the files starts a builder of its own, so a company's
   * creation then starts a second one.
   */
  it('shares its builder with the creation of a company', async () => {
    w.worker = { ...aWorker(), provingWarmed: async () => {} };
    const m = await load();
    m.warmTheProving();
    await (await import('./vault-builder.js')).theCreationBuilder();
    await settle();
    expect(w.starts).toBe(1);
  });
});


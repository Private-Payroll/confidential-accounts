import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { readOutcome } from 'midnight-identity/profile/act-channel';
import { intentShapeOf, type ActIntent } from 'midnight-identity/profile/request';
import { StepRefused, type StepContext } from './definition.js';

/*
 * The company's key repaired from the wallet: a new key made from the newest one this seat holds, wrapped to every
 * signer who stays, the payout seed kept. What is pinned: the person confirms it first; the change is asked of the
 * shared code as a repair (stood in for here; followed in company-key-here.test.ts); a change filed meanwhile by the
 * act's own upkeep files nothing more; and each way the shared code declines is said in the act's own words.
 */
const t = vi.hoisted(() => ({
  calls: [] as string[],
  asked: [] as unknown[],
  newest: 1,
  rotated: null as null | (() => unknown),
}));
vi.mock('../../../../packages/web-shared/src/company-key-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/company-key-here.js')>()),
  rotateTheCompanyKeyHere: async (_doors: unknown, o: unknown) => { t.calls.push('rotate'); t.asked.push(o); return t.rotated!(); },
}));
vi.mock('./upkeep.js', async (real) => ({
  ...(await real<typeof import('./upkeep.js')>()),
  rotationDoorsIn: async () => ({}),
  upkeepSteps: (company: { reach: (c: unknown) => Promise<unknown>; renew: () => void }) => ({
    first: { title: { key: 'act.upkeep.step.first' }, run: async (c: unknown) => { t.calls.push('upkeep-first'); await company.reach(c); } },
    last: { title: { key: 'act.upkeep.step.last' }, run: async (c: unknown) => { t.calls.push('upkeep-last'); await company.reach(c); } },
  }),
}));
const { repairCompanyKeyAction } = await import('./repair-company-key.js');

const WORDS = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
const INTENT = { name: 'repair-company-key', fields: { record: 'acc_1', company: 'co_x', account: 'c0'.repeat(32) } } as unknown as ActIntent;
const reachOf = () => ({ accountId: 'acc_1', api: async () => ({}), stepTo: () => {}, companyKeys: { newest: t.newest } });
const action = () => repairCompanyKeyAction({ chain: () => ({}) as never, builder: () => ({}) as never, reachFor: async () => reachOf() as never });
const runOf = async () => {
  const told: Array<Record<string, unknown>> = [];
  const confirmed: string[] = [];
  const ctx = {
    intent: INTENT, tell: (x: Record<string, unknown>) => { told.push(x); },
    confirm: async (lines: readonly { key: string }[]) => { t.calls.push('confirm'); confirmed.push(...lines.map((l) => l.key)); },
  } as unknown as StepContext;
  for (const step of action().steps(INTENT)) await step.run(ctx);
  return { told, confirmed };
};

beforeEach(() => {
  t.calls.length = 0;
  t.asked.length = 0;
  t.newest = 1;
  t.rotated = () => ({ state: 'rotated', epoch: 2, version: 9 });
});

describe('THE COMPANY\'S KEY IS REPAIRED IN THE WALLET', () => {
  it('the person confirms the repair, then the shared code is asked for a repair between the upkeep\'s two steps', async () => {
    const { told, confirmed } = await runOf();
    /* RED WHEN: the key is changed before the person confirms it, or outside the act's upkeep. */
    expect(t.calls).toEqual(['confirm', 'upkeep-first', 'rotate', 'upkeep-last']);
    /* RED WHEN: the shared code is asked for an ordinary change of the key, not a repair. */
    expect(t.asked).toEqual([{ repair: true }]);
    expect(confirmed).toEqual(['act.repair-company-key.confirm.repair']);
    expect(told).toContainEqual({ state: 'rotated', epoch: 2 });
  });

  it('a change of the key filed during the act\'s own upkeep files nothing more', async () => {
    let read = 0;
    t.newest = 1;
    const bumped = () => ({ accountId: 'acc_1', api: async () => ({}), stepTo: () => {}, companyKeys: { newest: (read += 1) === 1 ? 1 : 2 } });
    const told: Array<Record<string, unknown>> = [];
    const ctx = { intent: INTENT, tell: (x: Record<string, unknown>) => { told.push(x); }, confirm: async () => {} } as unknown as StepContext;
    const a = repairCompanyKeyAction({ chain: () => ({}) as never, builder: () => ({}) as never, reachFor: async () => bumped() as never });
    for (const step of a.steps(INTENT)) await step.run(ctx);
    /* RED WHEN: a key the upkeep has just changed is changed a second time, so readers' grants are wrapped twice. */
    expect(t.calls).not.toContain('rotate');
    expect(told).toContainEqual({ state: 'rotated-elsewhere', epoch: 2 });
  });

  it('each way the shared code declines is refused in the act\'s words, with what clears it', async () => {
    for (const state of ['not-rotated', 'waits', 'not-this-seat'] as const) {
      t.rotated = () => ({ state, why: 'this seat holds no copy of the company\'s newest key' });
      const e = await runOf().then(() => null, (x: unknown) => x);
      /* RED WHEN: a repair this seat could not make is told to the page as done. */
      expect(e, state).toBeInstanceOf(StepRefused);
      expect((e as StepRefused).words).toEqual({ key: `act.repair-company-key.why.${state}`, values: { says: 'this seat holds no copy of the company\'s newest key' } });
    }
  });

  it('its words say nothing of readers being granted again, and its outcome is one the page reads', () => {
    const mine = Object.entries(WORDS).filter(([k]) => k.startsWith('act.repair-company-key.'));
    expect(mine.length).toBeGreaterThan(5);
    /* RED WHEN: the act tells a person readers must be granted again, which the upkeep's wrapping of the grants makes false. */
    for (const [k, v] of mine) expect(v, k).not.toMatch(/granted again|re-?grant/iu);
    /* RED WHEN: the window says the new key is made from the newest, or promises the grants are wrapped again whatever the upkeep finds. */
    expect(WORDS['act.repair-company-key.shown.what']).toMatch(/makes a new company key, seals the newest one your seat holds inside it/u);
    expect(WORDS['act.repair-company-key.shown.readers']).toMatch(/unless the upkeep cannot do it: then this action says the upkeep was not all done/u);
    expect(intentShapeOf('repair-company-key')).not.toBeNull();
    expect(readOutcome({ state: 'rotated', epoch: 2, upkeep: 'done', anchored: 1 }, 'repair-company-key')).not.toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import type { StepContext } from './definition.js';
import { stepOverItsCall } from './step-views.test-support.js';

/*
 * **A COMPANY IS READ ONCE FOR EACH STEP, THROUGH THAT STEP'S OWN VIEW, AND NEVER KEPT INTO THE NEXT.** An action
 * reads its company in each step that needs it, through the view the step was given, and every ask of the same step
 * is answered by that one read. Every call and send it makes reaches the page with the step's own number, so the page
 * says the step the action is really on. The company's judges are stood in only to make one read of their own through
 * the view the read hands them.
 */

vi.mock('../../../../packages/web-shared/src/company-judges.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/company-judges.js')>()),
  companyJudges: (d: { view: (id: string) => { list: (kind: 'proposals') => Promise<unknown> } }) => ({
    companyKeysFor: async () => ({}),
    probe: () => d.view('acc_1').list('proposals'),
  }),
}));

const { vaultKeysSteps } = await import('./give-vault-keys.js');
const { keptReach, companyReachFor } = await import('./company-reach.js');

const secret = newSecret();
const identity = identityFromSecret(secret);
const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const LEAF = 'aa'.repeat(32);
const SEAT = {
  signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: '04'.repeat(32),
};
const SEALED = { id: 'acc_1', companyLabel: LABEL, contractAddress: ACCOUNT, wrappedKeys: [] };
const why = (key: string) => ({ key });

const world = () => {
  const seen: Array<[number, string]> = [];
  let reads = 0;
  const chain = {
    indexer: { indexerUri: 'https://indexer.example', indexerWsUri: 'wss://indexer.example' },
    holders: async () => {
      reads += 1;
      return { seats: [LEAF], committee: [], threshold: 1, approvals: 1, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT, founding: LEAF } as never;
    },
    callState: async () => null,
  };
  const builder = { ownSeat: async () => LEAF } as never;
  const at = (step: number): StepContext => {
    const call = async (method: string, path: string, body?: string) => {
      seen.push([step, `${method} ${path}`]);
      /* The service as a view reads it first: no directory filed yet, and no record entered. */
      if (path.endsWith('/directory')) return { status: 200, body: { filings: [] } };
      if (path.endsWith('/manifest/newest')) return { status: 200, body: { versions: (JSON.parse(body!) as { records: unknown[] }).records.map(() => 0) } };
      return { status: 200, body: SEALED };
    };
    return stepOverItsCall({
      intent: { name: 'give-vault-keys', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT } } as ActIntent,
      asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
      held: { identity, secret },
      at: { step, steps: 5 }, signal: new AbortController().signal,
      relay: async () => {},
      call,
      tell: () => {},
      keyring: { open: () => ({ read: () => ({ accounts: { acc_1: SEAT } }) }) as never, keep: async () => {} },
    }) as unknown as StepContext;
  };
  return { seen, reads: () => reads, chain, builder, at };
};

const throughEveryDoor = async (r: { stepView: { current(): { list(kind: string): Promise<unknown> } }; judges: unknown }) => {
  await r.stepView.current().list('people');
  await (r.judges as { probe: () => Promise<unknown> }).probe();
};
const LATER = (step: number) => [[step, 'GET /api/accounts/acc_1/people'], [step, 'GET /api/accounts/acc_1/proposals']];

describe('a company is read once for each step, through the step\'s own view', () => {
  it('giving vault keys reads the company again in a later step, and hands the page each call with that step\'s number', async () => {
    const w = world();
    const keys = vaultKeysSteps({ chain: () => w.chain, builder: () => w.builder, now: () => 1 } as never, why, 'act.give-vault-keys');
    const first = await keys.company(w.at(1));
    const readsAtFirst = w.reads();
    w.seen.length = 0;
    const later = await keys.company(w.at(4));
    /* RED WHEN: a later step relies on what an earlier step read of the company instead of reading it through its own view. */
    expect(later).not.toBe(first);
    expect(w.reads()).toBeGreaterThan(readsAtFirst);
    w.seen.length = 0;
    await throughEveryDoor(later as never);
    /* RED WHEN: a read through the step's view or a judge's own read a later step makes reaches the page tagged with another step. */
    expect(w.seen).toEqual(LATER(4));
  });

  it('every ask of one step is answered by the step\'s one read, and the read is let go when the step reads again', async () => {
    const w = world();
    const kept = keptReach((ctx) => companyReachFor(ctx, w.chain, w.builder, why));
    const step = w.at(3);
    const first = await kept.at(step);
    const readsAtFirst = w.reads();
    /* RED WHEN: a second ask of the same step reads the company again. */
    expect(await kept.at(step)).toBe(first);
    expect(w.reads()).toBe(readsAtFirst);
    /* RED WHEN: the next step is handed the company the step before read. */
    expect(await kept.at(w.at(4))).not.toBe(first);
    const again = w.at(5);
    const before = await kept.at(again);
    kept.renew();
    /* RED WHEN: a read let go inside a step (after the company's key changed) is still used, or its view still answers. */
    const after = await kept.at(again);
    expect(after).not.toBe(before);
    expect(before.stepView.current().ended).not.toBeNull();
  });
});

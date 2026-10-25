import { describe, expect, it, vi } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import type { StepContext } from './definition.js';

/*
 * **A COMPANY READ ONCE IS REACHED, IN EVERY LATER STEP, AS THAT STEP.** An action reads its company in the first step
 * that needs it and keeps what it read and judged for the steps after. Every call and send a later step makes through
 * it reaches the page with the later step's number, so the page says the step the action is really on. The company's
 * judges are stood in only to make one call of their own through the service the read hands them.
 */

vi.mock('../../../../packages/web-shared/src/company-judges.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/company-judges.js')>()),
  companyJudges: (d: { api: (path: string) => Promise<unknown> }) => ({
    companyKeysFor: async () => ({}),
    probe: () => d.api('/api/accounts/acc_1/directory'),
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
  const at = (step: number): StepContext => ({
    intent: { name: 'give-vault-keys', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT } } as ActIntent,
    asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity, secret },
    at: { step, steps: 5 }, signal: new AbortController().signal,
    relay: async () => {},
    call: async (method: string, path: string) => { seen.push([step, `${method} ${path}`]); return { status: 200, body: SEALED }; },
    tell: () => {},
    keyring: { open: () => ({ read: () => ({ accounts: { acc_1: SEAT } }) }) as never, keep: async () => {} },
  }) as unknown as StepContext;
  return { seen, reads: () => reads, chain, builder, at };
};

const throughEveryDoor = async (r: { api: (p: string) => Promise<unknown>; send: (p: string, i: never) => Promise<unknown>; judges: unknown }) => {
  await r.api('/api/accounts/acc_1');
  await r.send('/api/accounts/acc_1/records', { method: 'POST', body: '{}' } as never);
  await (r.judges as { probe: () => Promise<unknown> }).probe();
};
const LATER = (step: number) => [
  [step, 'GET /api/accounts/acc_1'], [step, 'POST /api/accounts/acc_1/records'], [step, 'GET /api/accounts/acc_1/directory'],
];

describe('a company read once is reached, in every later step, as that step', () => {
  it('giving vault keys hands the page each later call and send with the later step\'s number, and reads the company once', async () => {
    const w = world();
    const keys = vaultKeysSteps({ chain: () => w.chain, builder: () => w.builder, now: () => 1 } as never, why, 'act.give-vault-keys');
    const first = await keys.company(w.at(1));
    const readsAtFirst = w.reads();
    w.seen.length = 0;
    const later = await keys.company(w.at(4));
    /* RED WHEN: a later step reads the company again instead of keeping what the first step read and judged. */
    expect(later).toBe(first);
    expect(w.reads()).toBe(readsAtFirst);
    await throughEveryDoor(later as never);
    /* RED WHEN: a call, a send or a judge's own read a later step makes through the kept company reaches the page tagged with the first step. */
    expect(w.seen).toEqual(LATER(4));
  });

  it('a read kept by any action is reached as the step that takes it, and read again only after it is let go', async () => {
    const w = world();
    const kept = keptReach((ctx) => companyReachFor(ctx, w.chain, w.builder, why));
    const first = await kept.at(w.at(1));
    const readsAtFirst = w.reads();
    w.seen.length = 0;
    /* RED WHEN: a later step reads the company again, or reaches the page as the step that first read it. */
    expect(await kept.at(w.at(3))).toBe(first);
    expect(w.reads()).toBe(readsAtFirst);
    await throughEveryDoor(first as never);
    expect(w.seen).toEqual(LATER(3));
    kept.renew();
    /* RED WHEN: a read let go after the company's key changed is still used by the next step. */
    expect(await kept.at(w.at(4))).not.toBe(first);
  });
});

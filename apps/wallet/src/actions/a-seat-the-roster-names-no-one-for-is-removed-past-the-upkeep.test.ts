import { describe, expect, it, vi } from 'vitest';
import { identityFromSecret, newSecret } from 'midnight-identity/keys/derivation';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import type { ActIntent } from 'midnight-identity/profile/request';
import type { StepContext } from './definition.js';

/*
 * **THE REMOVAL OF A SEAT THE COMPANY'S ROSTER NAMES NO ONE FOR GOES PAST THE UPKEEP AND THE DEVICE'S OWN COUNT.** While
 * every read of the roster stops on a seat taken on an invitation the wallet cannot tie to that one invitation, the
 * action's real steps run in order: the first step's check, the upkeep's first step, and the raise. Only the shared
 * code's sending is stood in, and in its place the device's own count before each send (`removalApproversHere`) over
 * the doors and the company keys the wallet hands it, as the shared code runs it.
 */

/* The company's keys inside a door the shared code is handed, found by what they are (they answer `keyAt`) rather than by the field's name. */
const keysIn = vi.hoisted(() => (door: object): unknown => Object.values(door).find((v) => typeof v === 'object' && v !== null && 'keyAt' in v));
const t = vi.hoisted(() => ({ handed: [] as Array<{ leaf: string; name: string; approvers: string[]; directoryRead: boolean }>, keysCounted: [] as unknown[] }));
vi.mock('../../../../packages/web-shared/src/spending-policy-here.js', async (real) => ({
  ...(await real<typeof import('../../../../packages/web-shared/src/spending-policy-here.js')>()),
  bandsInForceHere: async (here: object) => { t.keysCounted.push(keysIn(here)); return []; },
}));
vi.mock('../../../../packages/web-shared/src/governed-call-on-device.js', async (real) => {
  const actual = await real<typeof import('../../../../packages/web-shared/src/governed-call-on-device.js')>();
  const { removalApproversHere } = await import('../../../../packages/web-shared/src/removal-approvers-here.js');
  return {
    ...actual,
    removeSignerOnDevice: async (doors: any, input: any) => {
      const here = await doors.records.directory({ records: [] });
      /* The count is made with the company's keys the wallet hands the shared code in the input, as the device's own check makes it. */
      const approvers = await removalApproversHere(doors, keysIn(input) as typeof KEYS);
      t.handed.push({ leaf: input.leaf, name: input.name, approvers: [...approvers.seats.keys()], directoryRead: here !== undefined });
      return { state: 'waiting-for-approvals', round: { id: 'prp_1', chainId: 'dd'.repeat(32), status: 'open' } };
    },
  };
});

const { removeSignerAction } = await import('./remove-signer.js');
const { RosterNotBelieved } = await import('../../../../packages/web-shared/src/roster-here.js');
const { seatingRefusedHolding } = await import('../../../../packages/web-shared/src/roster-seating-refused.js');
const { UNREAD_SEAT_NAME } = await import('./roster-for-a-removal.js');

const LABEL = drawCompanyLabel();
const ACCOUNT = 'c0'.repeat(32);
const SEATS = ['a1', 'a2', 'a3', 'a4'].map((x) => x.repeat(32));
const UNREAD = SEATS[3]!;
const KEYS = { epoch: 0, key: '11'.repeat(32), newest: 0, keyAt: () => '11'.repeat(32), sealing: () => ({ key: '11'.repeat(32), epoch: 0 }) };

/* Every read of the company's roster stops here, keeping Ada, Bo and Cy believed on their own directory entries. */
const seatingStop = () => seatingRefusedHolding(new RosterNotBelieved('The network shows a seat taken on an invitation this device cannot tie to it.', null, null, { check: 'seating-refused' }), {
  opened: { id: 'acc_1', name: 'Acme', signers: SEATS.slice(0, 3).map((leaf, i) => ({
    id: `s${i + 1}`, name: ['Ada', 'Bo', 'Cy'][i], status: 'active', leafCommitment: leaf, signingPublicKey: `0${i}`.repeat(32), userId: `usr_${i}`,
  })) } as never,
  witnesses: {
    accountId: 'acc_1', label: LABEL, account: ACCOUNT as never, seatsOnTheChain: SEATS, own: null,
    directory: SEATS.slice(0, 3).map((seat, i) => ({ seat, signingKey: `0${i}`.repeat(32), committeeKey: { tag: 't', value: 'v' }, retired: false, role: null, person: `usr_${i}` })),
  },
  waited: new Set<string>(),
}, [UNREAD]);

/* The company as this wallet reaches it: the chain's reads answer, and every read of the roster, direct or through a judge, stops. */
const reachOf = () => ({
  accountId: 'acc_1', label: LABEL, account: ACCOUNT, seat: { signerId: 's1', signingSecret: '01'.repeat(32), wrappingSecret: '02'.repeat(32), blinding: '03'.repeat(32), scope: 'cc'.repeat(32) },
  leaf: SEATS[0], companyKey: '11'.repeat(32), stepTo: () => {}, sealed: { id: 'acc_1' }, companyKeys: KEYS,
  api: async () => { throw seatingStop(); },
  send: async () => ({ status: 404, body: {} }),
  holders: async () => ({ seats: SEATS, committee: [], approvals: 1, seatBar: 1, policyBar: null, vaultThresholds: [], adoptedVaults: [], account: ACCOUNT }),
  roster: async () => { throw seatingStop(); },
  judges: {
    /* The directory as the wallet believes it: every seat with every right. */
    directoryHereFor: (_c: unknown, _l: unknown, _a: unknown, _k: unknown, roster: () => Promise<unknown>) => async () => {
      await roster();
      return { dir: { seats: SEATS.map((seat) => ({ seat, retired: null, rights: { every: true } })) } };
    },
    leavesFor: () => async () => [],
    /* The roster's own reads, each of which stops when it is made. */
    rosterReadsFor: () => ({ filings: async () => { throw seatingStop(); }, holders: async () => { throw seatingStop(); } }),
    companyKeysFor: async () => { throw seatingStop(); },
  },
  builder: { companyWide: async () => 'cc'.repeat(32), runsOutrun: async () => ({}), roundsOnChain: async () => ({}) },
  chain: { indexer: {}, callState: async () => null },
});

const ctxOf = (i: ActIntent) => {
  const told: Array<Record<string, unknown>> = [];
  const confirmed: unknown[] = [];
  const ctx = {
    intent: i, asker: { origin: 'https://app.example', name: 'Payroll', rdns: 'example.payroll' }, person: 'usr_a',
    held: { identity: identityFromSecret(newSecret()), account: 0 }, at: { step: 1, steps: 5 }, signal: new AbortController().signal,
    relay: async () => { throw new Error('a removal is sent through its calls, never a bare relay'); },
    call: async () => { throw seatingStop(); },
    tell: (x: Record<string, unknown>) => { told.push(x); },
    show: () => {},
    confirm: async (lines: unknown) => { confirmed.push(lines); },
    keyring: null,
  } as unknown as StepContext;
  return { ctx, told, confirmed };
};

describe('A SEAT THE ROSTER NAMES NO ONE FOR IS REMOVED PAST THE REAL UPKEEP', () => {
  it('the first step, the upkeep and the raise all go ahead while every roster read stops, and the device counts the believed signers', async () => {
    const i = { name: 'remove-signer', fields: { record: 'acc_1', company: LABEL, account: ACCOUNT, leaf: UNREAD } } as ActIntent;
    const { ctx, told, confirmed } = ctxOf(i);
    const steps = removeSignerAction({
      chain: () => ({}) as never, builder: () => ({}) as never, pause: async () => {}, reachFor: async () => reachOf() as never,
      afterCarried: async () => ({}) as never,
    }).steps(i);
    /* The seat check, the upkeep's first step and the raise; the carrying out and the upkeep's last step are not this test's. */
    for (const step of steps.slice(0, 3)) await step.run(ctx);
    /* RED WHEN: the upkeep's first step stops on the roster's stop, so the removal that clears it is never raised. */
    expect(told).toContainEqual({ upkeep: 'partial' });
    expect(confirmed).toHaveLength(1);
    /* RED WHEN: the device's count before the send, or its read of the company's records, reads the roster that stops. */
    expect(t.handed).toEqual([{ leaf: UNREAD, name: UNREAD_SEAT_NAME, approvers: SEATS.slice(0, 3), directoryRead: true }]);
    expect(told).toContainEqual({ state: 'waiting-for-approvals' });
    /* RED WHEN: the wallet hands the shared code company keys other than this reach's own (`companyKeys`), or none, to count the approvers with. */
    expect(t.keysCounted.length).toBeGreaterThan(0);
    for (const keys of t.keysCounted) expect(keys).toBe(KEYS);
  });
});

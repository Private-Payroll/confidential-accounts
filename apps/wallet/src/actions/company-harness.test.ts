/*
 * The harness that counts a wallet action's calls is itself checked here: the company it makes holds the records
 * and open proposals asked for, filed and anchored, and grows when asked; every call an action makes is counted, under
 * the route the runner matches, and a call the action does not declare is refused; and the chain, builder and indexer
 * reads are counted by door. One action is counted at two sizes of the same company, and what it reads today at each
 * is pinned, so a change to how much it reads, either way, turns this red until the counts are measured again.
 */
import { describe, expect, it } from 'vitest';
import { intentShapeOf } from 'midnight-identity/profile/request';
import { vaultRecords, peopleRecords } from '../../../../src/server/a-company-of-two-seats.test-support.js';
import { ADA, anchorDoorsOf, CO, store } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { anchorTheRecordsHere } from '../../../../packages/web-shared/src/records-anchored-here.js';
import { throughAView } from '../../../../src/testing/anchor-doors-through-a-view.js';
import { aCompanyOf, addressOfWallet, companyDoors, countedCalls, doorsInFlight, runIntent, type Company, type Counted, type IntentCount } from './company-harness.test-support.js';

const company = aCompanyOf({ people: 3, vendors: 2, vaults: 2, proposals: 1 });
const PROVES = { timeout: 120_000 };

const invitedOf = (kind: string): number => store.listInvites(CO).filter((i) => i.kind === kind).length;
const holds = async (c: Company): Promise<{ people: number; vendors: number; named: number; secrets: number; proposals: number; unanchored: number }> => ({
  people: invitedOf('employee'),
  vendors: invitedOf('vendor'),
  named: (await Promise.all(c.vaults().map((v) => peopleRecords.get(CO, 'vault-info', v)))).filter((r) => r !== null).length,
  secrets: (await Promise.all(c.vaults().map((v) => vaultRecords.of('nonce-secret').get(v)))).filter((r) => r !== null).length,
  proposals: c.openProposals(),
  unanchored: (await anchorTheRecordsHere(throughAView(anchorDoorsOf(ADA)))).anchored,
});
const routesOf = (s: IntentCount['steps'][number]): number => Object.values(s.routes).reduce((a, b) => a + b, 0);
const total = (c: IntentCount): number => c.steps.reduce((n, s) => n + routesOf(s), 0);
const stepCounts = (c: IntentCount) => c.steps.map((s) => ({ routes: routesOf(s), doors: s.doors }));
const doorsOf = (holders: number, onChain: number, builder: number, indexer: number) => ({ holders, onChain, builder, indexer });
/*
 * What an invitation reads today, step by step: its calls to the service and its reads by door. Measured on this company
 * at three people, two vendors, two vaults and one open proposal, then at twice them, after the first invitation. The
 * two are the same: the last step reads every vault's state on the chain in one read, however many vaults there are.
 */
const INVITE_AT_N = [
  { routes: 15, doors: doorsOf(1, 1, 1, 2) }, { routes: 12, doors: doorsOf(1, 1, 1, 1) },
  { routes: 37, doors: doorsOf(4, 3, 5, 9) }, { routes: 36, doors: doorsOf(3, 3, 5, 4) },
];
const INVITE_AT_2N = [
  { routes: 15, doors: doorsOf(1, 1, 1, 2) }, { routes: 12, doors: doorsOf(1, 1, 1, 1) },
  { routes: 37, doors: doorsOf(4, 3, 5, 9) }, { routes: 36, doors: doorsOf(3, 3, 5, 4) },
];
const invite = (person: string) => runIntent('invite', {
  name: 'invite', fields: { ...company.fields, kind: 'signer', personName: person, role: 'approver', address: addressOfWallet(company.wallet(person)) },
} as never, company, ADA.person);

describe('A COMPANY OF A CHOSEN SIZE IS HELD BY THE SERVICE, AND EVERY CALL A WALLET ACTION MAKES ON IT IS COUNTED', PROVES, () => {
  let atN: IntentCount;

  it('the company holds the people, vendors, vaults and open proposals asked for, each filed and anchored', async () => {
    /* RED WHEN: the company is made without the people, vendors, vaults or open proposals asked for, or with records the anchor does not cover. */
    expect(await holds(company)).toEqual({ people: 3, vendors: 2, named: 2, secrets: 2, proposals: 1, unanchored: 0 });
  });

  it('every call an invitation makes reaches the service once and is counted under the route the runner matches', async () => {
    const before = company.served();
    atN = await invite('dee');
    /* RED WHEN: the company leaves an act's upkeep partial, so what is counted is an upkeep that stopped short. */
    expect(atN.told['upkeep']).toBe('done');
    /* RED WHEN: a call the action makes is not counted, or is counted without reaching the service. */
    expect(total(atN)).toBe(company.served() - before);
    /* RED WHEN: a call is counted under a name other than the method and pattern of a route the invitation declares. */
    const declared = new Set((intentShapeOf('invite')?.calls ?? []).map((r) => `${r.method} ${r.path}`));
    expect(atN.steps.flatMap((s) => Object.keys(s.routes)).filter((r) => !declared.has(r))).toEqual([]);
    /* RED WHEN: the chain's holders, the anchors or the builder are read without being counted against the step. */
    const doors = atN.steps.reduce((d, s) => ({ holders: d.holders + s.doors.holders, onChain: d.onChain + s.doors.onChain, builder: d.builder + s.doors.builder }), { holders: 0, onChain: 0, builder: 0 });
    expect(Math.min(doors.holders, doors.onChain, doors.builder)).toBeGreaterThan(0);
  });

  it('a call the action does not declare is counted and refused, as the runner refuses it', async () => {
    const counted: Counted[] = [];
    const call = countedCalls('invite', 2, async () => ({ status: 200, body: {} }), counted);
    /* RED WHEN: a call to a route the intent does not declare is passed on to the service. */
    await expect(call('POST', `/api/accounts/${CO}/vault-keys`, '{}')).rejects.toThrow(/does not declare/u);
    expect(counted).toEqual([{ step: 2, route: 'not declared' }]);
  });

  it('the company grows to twice the records, and the same invitation is counted step by step again', async () => {
    await company.growTo({ people: 6, vendors: 4, vaults: 4, proposals: 2 });
    /* RED WHEN: growing the company files nothing more, so the second count runs on the first size; the open proposals are the two raised and the first invitation's. */
    expect(await holds(company)).toEqual({ people: 6, vendors: 4, named: 4, secrets: 4, proposals: 3, unanchored: 0 });
    expect(company.size()).toMatchObject({ people: 6, vendors: 4, vaults: 4 });
    const before = company.served();
    const at2N = await invite('eve');
    expect(total(at2N)).toBe(company.served() - before);
    /* RED WHEN: a step that made no call is left out of a count, so the steps at the two sizes do not line up. */
    const steps = ['act.upkeep.step.first', 'act.invite.step.seat', 'act.invite.step.invite', 'act.upkeep.step.last'];
    expect([atN, at2N].map((c) => c.steps.map((s) => `${s.step} ${s.title}`))).toEqual([0, 1].map(() => steps.map((t, i) => `${i + 1} ${t}`)));
    /* RED WHEN: the invitation reads differently today at either size: measured again, the pins move with the wallet. */
    expect([atN, at2N].map(stepCounts)).toEqual([INVITE_AT_N, INVITE_AT_2N]);
  });
  it('a door ask is in flight until it is answered, and one made while no step is open fails the next count by name', async () => {
    const asked = companyDoors().chain.holders(undefined as never, undefined as never);
    /* RED WHEN: a door ask in flight is not known, so a screen's opening that waits on one is closed before it answers. */
    expect(doorsInFlight()).toBe(1);
    await asked;
    expect(doorsInFlight()).toBe(0);
    /* RED WHEN: a read made after its step ended is in no count and fails nothing, so a pin passes while that read grows. */
    await expect(invite('eve')).rejects.toThrow('a door was asked while no step was open, so the ask is in no count: holders holders');
  });
});

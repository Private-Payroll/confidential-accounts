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
import { ADA, anchorDoorsOf, BO, CO, rolesOnTheChain, store, takenFromTheOwnWallet } from '../../../../src/server/a-company-whose-signers-change-on-the-chain.test-support.js';
import { spendingPolicyKeysOf } from '../../../../packages/web-shared/src/governed-call-arguments.js';
import { pureCircuits } from '../../../../contracts/managed/contract/index.js';
import { assetIdHex, NIGHT } from '../../../../src/core/assets.js';
import { newBlinding } from '../../../../src/core/crypto.js';
import { anchorTheRecordsHere } from '../../../../packages/web-shared/src/records-anchored-here.js';
import { throughAView } from '../../../../src/testing/anchor-doors-through-a-view.js';
import { aCompanyOf, addressOfWallet, companyDoors, countedCalls, doorsInFlight, refuseWhatIsNotFiled, runIntent, type Company, type Counted, type IntentCount } from './company-harness.test-support.js';

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
  { routes: 40, doors: doorsOf(4, 3, 5, 9) }, { routes: 38, doors: doorsOf(3, 3, 5, 4) },
];
const INVITE_AT_2N = [
  { routes: 15, doors: doorsOf(1, 1, 1, 2) }, { routes: 12, doors: doorsOf(1, 1, 1, 1) },
  { routes: 40, doors: doorsOf(4, 3, 5, 9) }, { routes: 38, doors: doorsOf(3, 3, 5, 4) },
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

  it('the list of runs is refused, as the service refuses it, when it holds a run no chain wrote beside one a chain did', async () => {
    const runs = () => company.call(ADA.person)('GET', `/api/accounts/${CO}/runs`, undefined);
    /* Two runs put in the store by hand, one marked as a chain's and one as no chain's: no action files a run no chain wrote. */
    const run = (id: string, wiring: 'chain' | 'simulated') => ({
      id, accountId: CO, period: id, status: 'draft', payslips: [], keyEpoch: 0, sealed: { iv: '', tag: '', body: '' }, wiring,
    }) as Parameters<typeof store.putRun>[0];
    store.putRun(run('2026-10', 'chain'));
    /* RED WHEN: a list of runs a chain wrote is refused. */
    expect((await runs()).status).toBe(200);
    store.putRun(run('2026-11', 'simulated'));
    const refused = await runs();
    /* RED WHEN: a list holding a run no chain wrote beside one a chain did is answered, not refused with the service's code. */
    expect({ status: refused.status, code: (refused.body as { code?: string }).code }).toEqual({ status: 409, code: 'records-from-more-than-one-ledger' });
  });
  it('a size whose records the company cannot file is refused, each by why, and the size just inside each bound is not', () => {
    /* RED WHEN: a size the company cannot file as asked is let through, so a count runs on a company other than the one it names. */
    expect(() => refuseWhatIsNotFiled({ people: 1, vaults: 1, runs: 1 })).toThrow('this company raises no run beside people only invited');
    expect(() => refuseWhatIsNotFiled({ people: 0, vaults: 0, runs: 1 })).toThrow('a run or a one-off payment is paid from the company\'s first vault');
    expect(() => refuseWhatIsNotFiled({ people: 0, vaults: 0, oneOffs: 1 })).toThrow('a run or a one-off payment is paid from the company\'s first vault');
    expect(() => refuseWhatIsNotFiled({ people: 0, vaults: 1, runs: 1, payments: 2 })).toThrow('payments are the payments of runs raised');
    expect(() => refuseWhatIsNotFiled({ people: 0, vaults: 2, policies: 2 })).toThrow('a spending policy is set for each vault after the first');
    /* RED WHEN: a size the company can file is refused: every bound above is met here with nothing to spare. */
    expect(() => refuseWhatIsNotFiled({ people: 0, vaults: 2, runs: 1, payments: 1, oneOffs: 1, policies: 1 })).not.toThrow();
    expect(() => refuseWhatIsNotFiled({ people: 3, vaults: 0 })).not.toThrow();
  });

  it('the chain refuses a spending policy set with a commitment other than the one its policy makes, and sets the one it makes', async () => {
    const proposal = 'c1'.repeat(32);
    const send = (signer: string, order: Record<string, unknown>) => takenFromTheOwnWallet(Buffer.from(JSON.stringify({ signer, order })).toString('base64'));
    await send(ADA.seat, { circuit: 'propose', proposal, governance: { kind: 'set-spending-policy' } });
    await send(BO.seat, { circuit: 'approve', proposal });
    const terms = { bands: [{ ceiling: '10', approvals: '1' }, { ceiling: '20', approvals: '1' }, { ceiling: '30', approvals: '1' }, { ceiling: '40', approvals: '1' }], periodLimit: '100', periodStart: '0', periodLength: '60' };
    const asked = { vault: 'c2'.repeat(32), asset: assetIdHex(NIGHT), assetBlinding: 'c3'.repeat(32), policy: { terms, blinding: newBlinding() } };
    const keys = spendingPolicyKeysOf({ accountPure: pureCircuits as never }, asked as never);
    const other = spendingPolicyKeysOf({ accountPure: pureCircuits as never }, { ...asked, policy: { terms, blinding: newBlinding() } } as never);
    /* RED WHEN: the chain sets a policy whose commitment is not the one its policy makes, so a wrong commitment sent passes every count. */
    await expect(send(BO.seat, { circuit: 'setPolicy', proposal, ...asked, commitment: other.commitment })).rejects.toThrow('the commitment is not the one the policy makes');
    expect(rolesOnTheChain([keys.policyKey, keys.onKey]).map((r) => r.value)).toEqual([null, null]);
    /* RED WHEN: the chain refuses the commitment the policy makes, so the refusal above is not of the commitment. */
    await send(BO.seat, { circuit: 'setPolicy', proposal, ...asked, commitment: keys.commitment });
    expect(rolesOnTheChain([keys.policyKey, keys.onKey]).map((r) => r.value)).toEqual([keys.commitment!.toLowerCase(), '01']);
  });
});

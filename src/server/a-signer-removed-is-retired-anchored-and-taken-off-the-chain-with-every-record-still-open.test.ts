/**
 * **ONE SIGNER REMOVED, FOLLOWED FROM THE SIGNERS' OWN DEVICES TO THE CHAIN,
 * WITH EVERY RECORD THE COMPANY KEEPS STILL OPEN TO THE SIGNERS WHO STAY.**
 * Cy, an admin who filed the vault's spending policy, is removed: Ada's device
 * raises the removal and approves it, signing Cy's retirement with the press;
 * Bo's device approves it, signing the retirement too, and carries it out -
 * the retirement filed and anchored, and only then the chain asked to take
 * Cy's leaf off. Before the raise, Cy's policy and a directory version are
 * filed and not anchored: the raising device anchors them first, so the
 * retirement's boundary is drawn over them and the chain is asked only once
 * the anchor holds them. Then every
 * store the company keeps is read as a device reads it: the directory, the
 * roster, the company's records from their first header, the policy, the chain.
 * Last, Bo's device changes the company's key, and what the service stores
 * holds neither the new key nor anything it seals in the clear.
 *
 * Over real HTTP: the page's own device functions (`removeSignerOnDevice`) and
 * the service's own directory, records, roster and proposal routes, with the
 * company and its stand-ins as `a-company-whose-signers-change-on-the-chain`
 * names them. Each assertion names the step whose loss turns it red.
 */
import { describe, it, expect } from 'vitest';
import { removeSignerOnDevice, seatsLeavingHere } from 'vaults-web-shared/governed-call-on-device.js';
import { rosterHere } from 'vaults-web-shared/roster-here.js';
import { attestedIn } from 'vaults-web-shared/vault-page-doors.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { companyKeyHere, rotateTheCompanyKeyHere } from 'vaults-web-shared/company-key-here.js';
import { sign, type Hex } from '../core/crypto.js';
import type { Role } from '../core/types.js';
import { directoryChangeMessage, type DirectoryChange } from '../midnight/seat-directory.js';
import { aRecordFiledBy } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, anchorDoorsOf, aPolicyFiledBy, ADA, BO, CO, companyKeyDoorsOf, CY, deviceOf, directoryOf, events, KEY, policyReadBy,
  recordsReadBy, rosterDoorsOf, seatsOnTheChain, sendAs, store, walletOf, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

aCompanyWhoseSignersChange();

/** What a device asks of the company's records: every spending policy, with the directory. */
const EVERY_POLICY = { kinds: [{ store: 'company' as const, kind: 'spending-policy' }] };

/** The directory's next version, a role change signed by `by` at the seat bar of two, filed and not anchored. Returns its version. */
const aRoleChangeSignedBy = async (by: readonly Seat[], change: { seat: string; role: Role }): Promise<number> => {
  const version = store.directoryFilingsOf(CO).length + 1;
  const unsigned = { kind: 'role', ...change, threshold: 2, signatures: [] } as unknown as DirectoryChange;
  const message = directoryChangeMessage(CO, version, unsigned);
  const filing = { company: CO, version, change: { ...unsigned, signatures: by.map((s) => ({ publicKey: s.statement.signingKey as Hex, signature: sign(message, s.signingSecret) })) } };
  const r = await sendAs(by[0]!.person)(`/api/accounts/${CO}/directory/${version}`, { method: 'POST', body: JSON.stringify(filing) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return version;
};

describe('A SIGNER REMOVED FROM THE SIGNERS\' OWN DEVICES, TRACED TO THE CHAIN', () => {
  it('CY IS RETIRED IN THE DIRECTORY, ANCHORED, TAKEN OFF THE CHAIN AND LEFT OUT OF THE ROSTER, AND THE POLICY CY FILED STILL OPENS FOR ADA AND BO; BO\'S DEVICE THEN CHANGES THE KEY, AND THE SERVICE STORES NONE OF IT IN THE CLEAR', async () => {
    /* Before: Cy files a policy record and anchors it from Cy's own seat. */
    await CY.entered.enter([await aRecordFiledBy(CY, 'pol_filed_by_cy')]);
    expect((await anchorTheRecordsHere(anchorDoorsOf(CY))).anchored).toBeGreaterThan(0);
    /* Then, filed and not anchored when the removal is raised: Cy's spending policy, sealed to all three seats, and a directory version. */
    expect(await aPolicyFiledBy(CY, [ADA, BO, CY])).toBe(1);
    const pending = await aRoleChangeSignedBy([ADA, BO], { seat: ADA.seat, role: 'admin' });
    const before = await directoryOf(BO)(EVERY_POLICY);
    expect(before.records.directory.has(pending)).toBe(false);
    expect(before.records.notYetAnchored.some((e) => e.kind === 'spending-policy')).toBe(true);
    events.length = 0;
    const remove = { viewingKey: KEY, leaf: CY.seat, name: 'cy' };

    /* Ada's device raises the removal in one press: the raise is her approval, and her signature over the retirement goes with it. */
    const raised = await removeSignerOnDevice(deviceOf(ADA), remove).catch((e: unknown) => e);
    /*
     * RED WHEN: the raising device does not anchor the leaver's versions and the directory waiting before it raises, so
     * the removal is refused or its boundary drawn short of them; or the raise is not sealed into the company's records.
     */
    expect(raised).toMatchObject({ state: 'waiting-for-approvals' });
    expect(events).toEqual(['anchored', 'chain propose']);
    const raisedOver = await directoryOf(BO)(EVERY_POLICY);
    expect(raisedOver.records.directory.has(pending)).toBe(true);
    expect(raisedOver.records.notYetAnchored).toEqual([]);
    /* RED WHEN: a removal raised with one approval, short of the seat bar of two, already counts Cy as leaving. */
    expect(await seatsLeavingHere(deviceOf(BO), KEY)).toEqual(new Set());

    /* Bo's device approves it, which reaches the seat bar of two, and carries it out. */
    const carried = await removeSignerOnDevice(deviceOf(BO), remove).catch((e: unknown) => e);
    /*
     * RED WHEN: an approval does not carry its seat's signature over the retirement, or the service does not keep it
     * beside the proposal, or the retirement is filed and not anchored at once.
     */
    expect(carried).toMatchObject({ state: 'done' });
    const proposal = store.listProposals(CO).at(-1)!;
    expect(proposal.status).toBe('executed');
    expect(new Set(proposal.retirementSignatures?.map((x) => `${x.signedFor} ${x.publicKey}`)))
      .toEqual(new Set([`7 ${ADA.statement.signingKey}`, `7 ${BO.statement.signingKey}`]));

    /* RED WHEN: the chain is asked to take the leaf off before the retirement is filed and anchored, or the leaver's own policy before it. */
    expect(events).toEqual([
      'anchored', 'chain propose', 'chain approve', 'directory 7 retire', 'anchored', `chain amendSigner removing ${CY.seat}`,
    ]);
    /* RED WHEN: the chain call is not relayed, or the chain keeps the leaf. */
    expect(seatsOnTheChain()).toEqual([ADA.seat, BO.seat]);

    /* The directory, as each staying device believes it: Cy retired at the seat bar, keeping the policy version Cy filed, with Cy's own statement. */
    const filed = store.directoryFilingsOf(CO).at(-1)!;
    expect(filed.change).toMatchObject({ kind: 'retire', seat: CY.seat, threshold: 2, statement: { recordsKey: walletOf(CY).recordsKey.recordsKey } });
    for (const s of [ADA, BO]) {
      const here = await directoryOf(s)();
      const cy = here.dir.seats.find((x) => x.seat === CY.seat)!;
      /* RED WHEN: the directory judge does not retire the seat its quorum signed off. */
      expect(Object.entries(cy.retired ?? {}).sort(), s.person).toEqual([['policy:pol_filed_by_cy', 1], [expect.stringMatching(/^spending-policy:/u), 1]]);
      expect(here.records.directory.has(7), s.person).toBe(true);
    }

    /* The roster each staying device believes leaves Cy out, so no statement of Cy's is read from it any more. */
    const roster = await rosterHere(rosterDoorsOf(BO));
    /* RED WHEN: the roster goes on believing a seat the anchored directory retired, until the chain no longer holds it. */
    expect(roster.account.signers.map((x) => x.name).sort()).toEqual(['ada', 'bo']);
    expect(roster.refused).toContainEqual(expect.objectContaining({ name: 'cy', why: 'seat-retired' }));
    expect(attestedIn(roster.account).map((a) => a.statement.seat)).not.toContain(CY.seat);
    for (const s of [ADA, BO]) {
      /* RED WHEN: a retired seat is judged by the roster's statements, not by the one its retirement carries, once the roster drops it. */
      expect((await directoryOf(s)()).another.has(CY.seat), s.person).toBe(false);
    }

    /* The company's records, checked from their first header on each staying device: every batch opens, the leaver's policy among them. */
    for (const s of [ADA, BO]) {
      const read = await recordsReadBy(s, EVERY_POLICY);
      /* RED WHEN: a batch anchored before the removal - one by Cy's own seat - is judged by the directory as it stands now. */
      expect(read.records.stopped, s.person).toBeNull();
      expect([...read.records.history.keys()].some((k) => k.startsWith('company:spending-policy:')), s.person).toBe(true);
    }

    /* The policy Cy filed still opens for the signers who stay, at the version the chain's commitment is made from. */
    for (const s of [ADA, BO]) {
      /* RED WHEN: a version sealed to a seat retired after it was anchored stops being believed. */
      expect(await policyReadBy(s).catch((e: unknown) => e), s.person).toMatchObject({ state: 'set', version: 1 });
    }

    /* Bo's device changes the company's key once the removal is done, and reads it back. */
    const doors = {
      ...companyKeyDoorsOf(BO), accountId: CO, material: { signingSecret: BO.signingSecret }, records: deviceOf(BO).records!,
      leaving: async () => new Set<string>(),
    };
    expect(await rotateTheCompanyKeyHere(doors, { leaf: CY.seat })).toMatchObject({ state: 'rotated', epoch: 1 });
    const keys = await companyKeyHere(doors);
    expect(keys.epoch).toBe(1);
    const held = JSON.stringify(store.snapshot()).toLowerCase();
    /* RED WHEN: the change of the company's key leaves the new key, or the payout seed it carries, readable in what the service stores. */
    expect(held).not.toContain(keys.key.toLowerCase().replace(/^0x/u, ''));
    expect(keys.seeds.map((x) => x.epoch)).toEqual([1]);
    for (const x of keys.seeds) expect(held).not.toContain(String(x.seed).toLowerCase().replace(/^0x/u, ''));
    /* RED WHEN: the company's name is stored in the clear. */
    expect(held).not.toContain('acme');
  }, 170_000);
});

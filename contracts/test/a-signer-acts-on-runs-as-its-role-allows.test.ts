/*
 * A signer seated through the product's own path - its role's rights (`rightsOfRole`), the scope its leaf commits to
 * (`scopeOfRole`), and the record its device proves with (`signerMaterialOf`, `signerHalfOf`) - raises, approves and
 * holds runs on the chain exactly as its role allows, and no more.
 */
import { describe, it, expect } from 'vitest';
import { AccountSimulator, privateStateFor, change, payoutTreeOf, sumArgsOf } from './simulator.js';
import { pureCircuits } from '../managed/contract/index.js';
import type { AccountPrivateState } from '../src/witnesses.js';
import { fromHex, toHex, type Hex } from '../../src/core/crypto.js';
import { COMPANY_WIDE, scopeOfRole, seatRightsRecordOf } from '../../src/core/seat-rights.js';
import type { SignerRole } from '../../src/core/roles.js';
import { signerHalfOf, signerMaterialOf } from '../../packages/web-shared/src/private-state.js';

type Device = AccountPrivateState;

const fill = (n: number) => new Uint8Array(32).fill(n);
const PAYROLL = fill(0xa1);
const TREASURY = fill(0xb2);
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** A device seated at `role` on `vaults`, its private state composed from its saved seat as every wallet act composes it. */
const seatedAs = (seed: number, role: SignerRole, vaults?: Uint8Array[]): Device => {
  const base = privateStateFor(seed);
  const named = vaults?.map((v) => toHex(v) as Hex);
  const record = seatRightsRecordOf(role, named);
  const material = signerMaterialOf({
    signingSecret: toHex(base.secretKey), blinding: toHex(base.blinding), scope: scopeOfRole(role, named), ...(record === null ? {} : { rights: record }),
  });
  return { ...base, ...signerHalfOf(material) };
};

const A = privateStateFor(1);

const live = async (devices: Device[], threshold: bigint) => {
  const sim = await AccountSimulator.liveAccount(devices, threshold);
  sim.at(NOW);
  await sim.adoptVault(PAYROLL, devices.slice(0, Number(threshold)));
  await sim.adoptVault(TREASURY, devices.slice(0, Number(threshold)), 392);
  return sim;
};

interface Run { id: Uint8Array; c: ReturnType<typeof change>; payload: Uint8Array; vault: Uint8Array; pay: () => Promise<unknown> }

const raiseRun = async (sim: AccountSimulator, by: Device, vault: Uint8Array, seed: number): Promise<Run> => {
  const c = change(0n, seed);
  const tree = payoutTreeOf([{ details: toHex(fill(0x10)), nonce: toHex(fill(seed)) }]);
  await sim.as(sim.applying(by, c)).proposeRun({ root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, vault, required: 0n });
  const payload = pureCircuits.runPayload(fromHex(tree.root), tree.payees, OPENS, CLOSES, 0n);
  const id = sim.proposalId(payload, c.salt, vault);
  const pay = () => sim.as(sim.applying(A, c)).recordPaymentFromVault({
    proposal: id, vault, root: fromHex(tree.root), payees: tree.payees, from: OPENS, until: CLOSES, required: 0n, salt: c.salt,
    details: fill(0x10), nonce: fill(seed), ...sumArgsOf(tree, 0),
  });
  return { id, c, payload, vault, pay };
};

const knowing = (d: Device, run: Run): Device => ({
  ...d, runOpenings: { ...(d.runOpenings ?? {}), [hex(run.id)]: { payload: run.payload, vault: run.vault, salt: run.c.salt } },
});

const NOT_RAISE = /your seat does not let you propose payments from that vault or finish setting it up/;
const NOT_APPROVE = /your seat does not let you approve payments from that vault or finish setting it up/;

describe('a signer acts on runs on the chain only as its role allows', () => {
  it('an approver seated at its role\'s rights approves a run, and is refused raising one', async () => {
    const approver = seatedAs(51, 'approver');
    const sim = await live([A, approver], 1n);
    /* RED WHEN: an approver is seated with every right, and raises runs its role does not allow. */
    await expect(raiseRun(sim, approver, PAYROLL, 61)).rejects.toThrow(NOT_RAISE);
    const run = await raiseRun(sim, A, PAYROLL, 62);
    /* RED WHEN: the rights an approver is seated with do not reach its proof, so it can approve nothing. */
    await sim.as(knowing(approver, run)).approve(run.id);
    expect(sim.approvalsFor(run.id)).toBe(2n);
  });

  it('an initiator raises a run that its raise does not approve, and is refused approving one', async () => {
    const initiator = seatedAs(52, 'initiator');
    const sim = await live([A, initiator], 1n);
    const run = await raiseRun(sim, initiator, TREASURY, 63);
    /* RED WHEN: an initiator's own raise counts as an approval of the run it raised. */
    expect(sim.approvalsFor(run.id)).toBe(0n);
    await expect(run.pay()).rejects.toThrow(/not enough approvals yet/);
    /* RED WHEN: an initiator is given the approve right. */
    await expect(sim.as(knowing(initiator, run)).approve(run.id)).rejects.toThrow(NOT_APPROVE);
    await sim.as(A).approve(run.id);
    await run.pay();
  });

  it('a seat scoped to one vault approves there, never on another vault or a company-wide run', async () => {
    const payrollApprover = seatedAs(53, 'approver', [PAYROLL]);
    const sim = await live([A, payrollApprover], 1n);
    const onPayroll = await raiseRun(sim, A, PAYROLL, 64);
    await sim.as(knowing(payrollApprover, onPayroll)).approve(onPayroll.id);
    const onTreasury = await raiseRun(sim, A, TREASURY, 65);
    /* RED WHEN: a seat scoped to one vault approves another vault's run. */
    await expect(sim.as(knowing(payrollApprover, onTreasury)).approve(onTreasury.id)).rejects.toThrow(NOT_APPROVE);
    const companyWide = await raiseRun(sim, A, fromHex(COMPANY_WIDE), 66);
    /* RED WHEN: a seat scoped to named vaults acts on a company-wide run, which nearly every vault may pay. */
    await expect(sim.as(knowing(payrollApprover, companyWide)).approve(companyWide.id)).rejects.toThrow(NOT_APPROVE);
  });

  it('a seat scoped to one vault raises and holds runs there, and is refused raising or holding a company-wide run', async () => {
    const payrollAdmin = seatedAs(55, 'admin', [PAYROLL]);
    const sim = await live([A, payrollAdmin], 2n);
    const wide = fromHex(COMPANY_WIDE);
    /* RED WHEN: a seat scoped to named vaults raises a company-wide run, which nearly every vault may pay. */
    await expect(raiseRun(sim, payrollAdmin, wide, 68)).rejects.toThrow(NOT_RAISE);
    const companyWide = await raiseRun(sim, A, wide, 69);
    /* RED WHEN: a seat scoped to named vaults holds a company-wide run. */
    await expect(sim.as(knowing(payrollAdmin, companyWide)).holdRun(companyWide.id)).rejects.toThrow(/your seat does not let you hold runs on that vault/);
    /* On its own vault it raises and holds. */
    await raiseRun(sim, payrollAdmin, PAYROLL, 70);
    const onPayroll = await raiseRun(sim, A, PAYROLL, 71);
    await sim.as(knowing(payrollAdmin, onPayroll)).holdRun(onPayroll.id);
  });

  it('an admin on every vault is seated with every right and needs no record to approve', async () => {
    const admin = seatedAs(54, 'admin');
    /* RED WHEN: an admin on every vault is seated with a rights record instead of every right. */
    expect(admin.rights).toBeNull();
    const sim = await live([A, admin], 1n);
    const run = await raiseRun(sim, admin, PAYROLL, 67);
    expect(sim.approvalsFor(run.id)).toBe(1n);
  });
});

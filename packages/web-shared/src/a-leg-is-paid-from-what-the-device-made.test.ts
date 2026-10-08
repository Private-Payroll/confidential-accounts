/**
 * **AN APPROVED LEG IS PAID FROM WHAT THE SIGNER'S DEVICE MAKES FROM THE
 * COMPANY'S RECORDS**, and that is what the service would have handed over for
 * the same leg. A run is drawn and raised by the payroll service; the device
 * reads the company's records and builds every payee's payment, and the view of
 * who is paid, itself.
 *
 * **WHAT IS A STAND-IN, SAID HERE:** the company is made by the service's own
 * creation, so its first state is re-signed here as its founding seat's record;
 * the directory and the wallet's read are given as a device holds them; and the
 * read of who is paid is the simulated ledger's, which records nobody.
 */
import { describe, expect, it } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';
import { AccountService } from '../../../src/core/account.js';
import { PayrollService } from '../../../src/core/payroll.js';
import { SimulatedLedger } from '../../../src/core/ledger.js';
import { FileStore } from '../../../src/core/store-file.js';
import { canonical, newSigningKeypair, parseCanonical, seal, toHex, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { openRecord, sealRecord } from '../../../src/core/sealed-records.js';
import { signedFoundingState } from '../../../src/core/founding-state.js';
import { MidnightCommitments } from '../../../src/midnight/commitments.js';
import { runMaterialFor } from '../../../src/midnight/run-material.js';
import { buildRun, rootOfPayments } from '../../../src/midnight/payout-tree.js';
import { assemblePrivatePayments } from '../../../src/midnight/private-payment-wire.js';
import { runPayments } from '../../../src/midnight/run-status.js';
import { vaultDetails } from '../../../src/testing/vault-details.js';
import { runsFiledBy } from '../../../src/testing/runs-a-seat-filed.js';
import { registryWithTestPrivateForms, aVaultHolding, TEST_TOKEN } from '../../../src/testing/assets.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import { NotMadeHere } from './material-made-here.js';
import { paymentViewHere, privatePaymentsHere, type PaymentsHereDeps } from './payments-made-here.js';

const VAULT = toHex(new Uint8Array(32).fill(0xa1));
const NOW = Math.floor(Date.now() / 1000);
const SEAT = '4e'.repeat(32);
const COMMITTEE = { tag: 'schnorr', value: '7a'.repeat(32) };

const aRaisedRun = async (o: { sent?: boolean } = {}) => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s293-paid-')), 'db.json'));
  const registry = registryWithTestPrivateForms();
  const ledger = new SimulatedLedger(MidnightCommitments);
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, registry);
  const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1, undefined, drawCompanyLabel());
  const account = created.account.id;
  const viewingKey = created.viewingKey as Hex;
  const hired = [0, 1, 2].map((i) => payroll.hireDirect(account, {
    name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: TEST_TOKEN, baseAmount: BigInt(100_00 + i),
  }, viewingKey).employee);
  const { run } = await payroll.createRunFromRoster(account, '2026-9', viewingKey);
  const i = await payroll.runMaterialInputs(run.id, viewingKey);
  const material = await runMaterialFor({
    accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts, pay: i.pay, asset: i.asset,
    opensAt: BigInt(NOW - 3_600), closesAt: BigInt(NOW + 3_600), vault: VAULT, detailsOf: vaultDetails,
  });
  await payroll.proposeRun(run.id, viewingKey, created.secrets[0]!.signerId, material, undefined, o.sent === false ? { onDevice: true } : undefined);
  const founder = newSigningKeypair();
  const state = signedFoundingState(account, { keyEpoch: 0, sealed: (await ledger.fetch(account, 0))!.sealedState }, founder.secret);
  const records: CompanyRecordsHere = {
    directory: async () => ({
      dir: { company: account, version: 1, seats: [{ seat: SEAT, person: 'ada', signingKey: founder.publicKey, wrappingKey: 'ab'.repeat(32), committeeKey: COMMITTEE, role: 'admin', retired: null }] },
      holders: { committee: [COMMITTEE], seats: [SEAT], approvals: 1, adoptedVaults: [], founding: SEAT, foundingCommittee: [COMMITTEE], account: 'ac'.repeat(32) } as never,
      another: new Set(),
    }),
    people: async () => ({ people: hired.map((e) => ({ person: payroll.person(e.id, viewingKey)!, version: 1, handedOver: true })), notBelieved: [], notPayable: [] }),
    state: async (id) => (id === '0' ? state : null),
    runs: async () => runsFiledBy(store.listRuns(account), account, founder.secret),
    proposals: async () => store.listProposals(account),
    registry,
    /* Paying reads neither what the wallet says of payments nor the company's ceilings. */
    payments: { paidOnceOf: () => { throw new Error('not read here'); }, paidMovementOf: () => { throw new Error('not read here'); }, read: async () => { throw new Error('not read here'); } },
    policy: async () => { throw new Error('not read here'); },
  };
  const deps: PaymentsHereDeps = {
    detailsOf: vaultDetails, runPayload: pureCircuits.runPayload, proposalIdOf: pureCircuits.proposalIdOf,
    paidAmong: (leaves) => ledger.paidAmong(account, [...leaves]),
  };
  return { store, ledger, accounts, payroll, account, viewingKey, runId: run.id, records, deps };
};

describe('AN APPROVED LEG, PAID FROM WHAT THIS DEVICE MADE', () => {
  it('EVERY PAYEE\'S PAYMENT IS WHAT THE SERVICE WOULD HAVE HANDED OVER FOR THE SAME LEG', async () => {
    const c = await aRaisedRun();
    const made = await privatePaymentsHere(c.records, c.account, c.runId, c.viewingKey, c.deps);
    /* The service's own assembly for the leg, as it was answered before a device made it. */
    const order = c.payroll.privatePaymentOrderOf(c.runId, c.viewingKey)!;
    const material = c.payroll.payoutMaterialOf(c.runId, c.viewingKey, { rootOf: rootOfPayments })!;
    const rebuild = (await c.payroll.payoutRebuildOf(c.runId, c.viewingKey))!;
    const among = await c.ledger.paidAmong(c.account, material.leaves);
    const service = assemblePrivatePayments({
      order, leaves: material.leaves, window: material.window, idFrom: material.proposal!.idFrom,
      built: buildRun(rebuild.seeds, rebuild.identity, rebuild.facts, vaultDetails, rebuild.pay, rebuild.asset),
      facts: rebuild.facts, paid: among?.known ? new Set(among.paid) : null,
    });
    if ('refusal' in service) throw new Error(service.refusal);
    /* RED WHEN: any payee's leaf, nonce, blinding, path, amount or address, or the proposal they are paid against, is made otherwise. */
    expect(made).toEqual(service.order);
    expect(made.payments).toHaveLength(3);
  });

  it('A LEG WHOSE LEAVES DO NOT REBUILD THE PROPOSAL ITS SIGNERS APPROVED IS NOT OFFERED TO PAY', async () => {
    const c = await aRaisedRun();
    /* RED WHEN: the identity the leaves rebuild is not compared with the one the chain opened the proposal under. */
    const otherSalt = { ...c.deps, proposalIdOf: (p: Uint8Array, v: Uint8Array) => pureCircuits.proposalIdOf(p, v, new Uint8Array(32).fill(7)) };
    await expect(privatePaymentsHere(c.records, c.account, c.runId, c.viewingKey, otherSalt)).rejects.toThrow(/not the ones its signers approved/u);
    /* RED WHEN: the approvals a round's identity binds are not read from its own record, so a round raised with a bar is rebuilt as one without. */
    const rec = c.store.listProposals(c.account)[0]!;
    const envelope = openRecord<{ sealedPayload: Sealed } & Record<string, unknown>>('proposals', c.account, rec.sealed, c.viewingKey);
    const payload = parseCanonical<Record<string, unknown>>(unseal(envelope.sealedPayload, c.viewingKey));
    const barred = { ...rec, sealed: sealRecord('proposals', c.account, { ...envelope, sealedPayload: seal(canonical({ ...payload, __required: 2n }), c.viewingKey) }, c.viewingKey) };
    await expect(privatePaymentsHere({ ...c.records, proposals: async () => [barred] }, c.account, c.runId, c.viewingKey, c.deps))
      .rejects.toThrow(/not the ones its signers approved/u);
    /* RED WHEN: a leg's payments are offered for a retry the leg does not record. */
    await expect(privatePaymentsHere(c.records, c.account, c.runId, c.viewingKey, c.deps, undefined, 'prp_none')).rejects.toThrow(NotMadeHere);
  });

  it('A LEG NOT YET ON THE CHAIN HAS NOTHING TO PAY', async () => {
    /* Written down and never sent: no chain was seen to hold its round. */
    const c = await aRaisedRun({ sent: false });
    /* RED WHEN: a round no chain was seen to hold is handed to a vault to pay. */
    await expect(privatePaymentsHere(c.records, c.account, c.runId, c.viewingKey, c.deps)).rejects.toThrow(/no round on the chain a vault can pay yet/u);
  });

  it('WHO THE LEG HAS PAID IS READ OVER ITS OWN LEAVES, VERIFIED AGAINST THE PROPOSAL, AS THE SERVICE READ IT', async () => {
    const c = await aRaisedRun();
    /* A read of the chain that knows who is paid, and records the first payee paid. */
    const material = c.payroll.payoutMaterialOf(c.runId, c.viewingKey, { rootOf: rootOfPayments })!;
    const known = { known: true, paid: [material.leaves[0]!] };
    const view = await paymentViewHere(c.records, c.account, c.runId, c.viewingKey, { ...c.deps, paidAmong: async () => known });
    /* RED WHEN: the view is built over other leaves or another window, or without the proof its leaves are the proposal's. */
    expect(view).toEqual(runPayments(material, known));
    expect(view.answered && view.status.verified).toBe(true);
    /* RED WHEN: a view over leaves that do not rebuild the proposal is reported on at all. */
    const otherSalt = { ...c.deps, paidAmong: async () => known, proposalIdOf: (p: Uint8Array, v: Uint8Array) => pureCircuits.proposalIdOf(p, v, new Uint8Array(32).fill(7)) };
    await expect(paymentViewHere(c.records, c.account, c.runId, c.viewingKey, otherSalt)).rejects.toThrow(/these are not that run's payees/u);
  });
});

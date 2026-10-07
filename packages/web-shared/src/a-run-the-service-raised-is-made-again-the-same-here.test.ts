/**
 * **A RUN RAISED BY THE ONE CODE THAT RAISES RUNS IS MADE AGAIN THE SAME ON AN
 * APPROVING DEVICE.** If the two ever disagreed about a leaf, a month or the
 * order of the people, every honest approval would be refused. Here a run is
 * drawn and raised by the payroll service and the approving device reads it
 * from the company's records and makes it again with the compiled circuits.
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
import { newSigningKeypair, toHex, fromHex, type Hex } from '../../../src/core/crypto.js';
import { signedFoundingState } from '../../../src/core/founding-state.js';
import { MidnightCommitments } from '../../../src/midnight/commitments.js';
import { runMaterialFor } from '../../../src/midnight/run-material.js';
import { vaultDetails } from '../../../src/testing/vault-details.js';
import { runsFiledBy } from '../../../src/testing/runs-a-seat-filed.js';
import { registryWithTestPrivateForms, aVaultHolding, TEST_TOKEN } from '../../../src/testing/assets.js';
import { runRebuiltHere, type CompanyRecordsHere } from './run-rebuilt-here.js';
import { refuseWhatThisDeviceDidNotMake } from './what-this-device-made.js';

const VAULT = toHex(new Uint8Array(32).fill(0xa1));
const NOW = Math.floor(Date.now() / 1000);
const SEAT = '4e'.repeat(32);
const COMMITTEE = { tag: 'schnorr', value: '7a'.repeat(32) };

describe('A RUN THE SERVICE RAISED', () => {
  it('IS MADE AGAIN THE SAME ON THE APPROVING DEVICE, AND ITS APPROVAL IS BUILT', async () => {
    const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s293-')), 'db.json'));
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
    const proposal = await payroll.proposeRun(run.id, viewingKey, created.secrets[0]!.signerId, material);

    /* The company's first state, as its founding seat would have signed it. */
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
      registry,
    };
    const made = await runRebuiltHere(records, account, proposal.id, viewingKey);
    const payKey = await accounts.payRecordKeyOf(account, viewingKey);
    const chain = {
      openProposals: { member: (id: Uint8Array) => toHex(id) === proposal.chainId },
      movements: { member: () => false },
      /* The pay-record key the company committed to: the one the service holds. */
      signerRoles: {
        member: (k: Uint8Array) => toHex(k) === toHex(pureCircuits.payKeyCommitmentKey()),
        lookup: () => pureCircuits.payKeyCommitmentOf(fromHex(payKey)),
      },
    };
    /* RED WHEN: the device makes any leaf, the month, the order or the payload other than the service raised it. */
    expect(() => refuseWhatThisDeviceDidNotMake(
      {
        runPayload: pureCircuits.runPayload, vaultDetails,
        payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf, payKeyCommitmentKey: pureCircuits.payKeyCommitmentKey,
      },
      { chainId: proposal.chainId, digest: proposal.digest, made }, chain)).not.toThrow();
    expect(made.facts.map((f) => f.amount)).toEqual([10000n, 10001n, 10002n]);
  });
});

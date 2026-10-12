/**
 * **WHAT A RAISE IS BUILT FROM IS MADE ON THE SIGNER'S DEVICE FROM THE
 * COMPANY'S RECORDS, AND IT IS WHAT THE SERVICE WROTE DOWN.**
 *
 * A run is drawn and written down by the payroll service, and the device reads
 * the company's records - its runs, its proposals, the state its founding seat
 * signed and the people it believes - and makes the legs, a leg's payments and
 * the raise's order itself. Each is compared with what the service holds for
 * the same proposal, so a device that made any of it differently would be
 * refused at the send for every honest raise.
 *
 * **WHAT IS A STAND-IN, SAID HERE:** the company is made by the service's own
 * creation, so its first state is re-signed here as its founding seat's record,
 * and the directory and the wallet's read of the chain are given as a device
 * would hold them.
 */
import { describe, expect, it, vi } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountService } from '../../../src/core/account.js';
import { PayrollService } from '../../../src/core/payroll.js';
import { SimulatedLedger } from '../../../src/core/ledger.js';
import { FileStore } from '../../../src/core/store-file.js';
import { canonical, newSigningKeypair, newSymmetricKey, parseCanonical, seal, toHex, unseal, type Hex, type Sealed } from '../../../src/core/crypto.js';
import { signedFoundingState } from '../../../src/core/founding-state.js';
import { paymentChecked, paymentsOnTheWire } from '../../../src/core/device-raise.js';
import { paysCommitmentOf } from '../../../src/core/proposal-filing.js';
import { legFieldsOf, proposalListOf, runLegOf } from '../../../src/core/run-legs.js';
import { openRecord, sealRecord } from '../../../src/core/sealed-records.js';
import { MidnightCommitments } from '../../../src/midnight/commitments.js';
import { runMaterialFor } from '../../../src/midnight/run-material.js';
import { vaultDetails } from '../../../src/testing/vault-details.js';
import { runsFiledBy } from '../../../src/testing/runs-a-seat-filed.js';
import { everyRunAndProposalEntered, heldEntering, roundsOnATestChain } from '../../../src/testing/record-tree-double.js';
import type { RoundOnChain } from './governed-call-builder.js';
import { registryWithTestPrivateForms, aVaultHolding, OTHER_TEST_TOKEN, TEST_TOKEN } from '../../../src/testing/assets.js';
import type { SealedProposal, SealedRun } from '../../../src/core/types.js';
import type { CompanyRecordsHere } from './run-rebuilt-here.js';
import {
  carryOrderHere, legPaymentsHere, legsHere, NotMadeHere, raiseOrderHere, retryOrderHere, retryPaymentsHere,
} from './material-made-here.js';
import { pureCircuits } from '../../../contracts/managed/contract/index.js';

const VAULT = toHex(new Uint8Array(32).fill(0xa1));
const NOW = Math.floor(Date.now() / 1000);
const SEAT = '4e'.repeat(32);
const COMMITTEE = { tag: 'schnorr', value: '7a'.repeat(32) };

/** A company the service made, three payees, one run drawn, and its records as a device reads them. */
/** The salt a proposal's identity is made with, from the change sealed in its payload. */
const saltOf = (rec: SealedProposal, account: string, viewingKey: Hex): string => {
  const envelope = openRecord<{ sealedPayload: Sealed }>('proposals', account, rec.sealed, viewingKey);
  return parseCanonical<{ __change: { salt: string } }>(unseal(envelope.sealedPayload, viewingKey)).__change.salt;
};

const aCompany = async (o: { writtenDown: boolean; alsoAnotherToken?: true }) => {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-s293-made-')), 'db.json'));
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
  if (o.alsoAnotherToken) {
    hired.push(payroll.hireDirect(account, { name: 'Payee X', email: 'x@a.co', title: 'Eng', asset: OTHER_TEST_TOKEN, baseAmount: 7_00n }, viewingKey).employee);
  }
  const { run } = await payroll.createRunFromRoster(account, '2026-9', viewingKey);
  let proposalId: string | undefined;
  if (o.writtenDown) {
    const i = await payroll.runMaterialInputs(run.id, viewingKey);
    const material = await runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts, pay: i.pay, asset: i.asset,
      opensAt: BigInt(NOW - 3_600), closesAt: BigInt(NOW + 3_600), vault: VAULT, detailsOf: vaultDetails,
    });
    proposalId = (await payroll.proposeRun(run.id, viewingKey, created.secrets[0]!.signerId, material, undefined, { onDevice: true })).id;
    /* What a filing from a seat's device commits to paying: the leg's recorded payments, from its vault, under its salt. */
    const rec = store.getProposal(proposalId)!;
    const leg = runLegOf(TEST_TOKEN, 'shielded');
    const recorded = payroll.requireRun(run.id, viewingKey).payout![leg]!.facts;
    /* And the run's own window, sealed beside what its identity is made from, as a seat's device seals it. */
    const envelope = openRecord<Record<string, unknown> & { sealedPayload: Sealed }>('proposals', account, rec.sealed, viewingKey);
    const payload = parseCanonical<Record<string, unknown>>(unseal(envelope.sealedPayload, viewingKey));
    const window = { root: material.run.root, payees: String(material.run.payees), opensAt: String(material.run.opensAt), closesAt: String(material.run.closesAt) };
    const sealedWithItsWindow = sealRecord('proposals', account, { ...envelope, sealedPayload: seal(canonical({ ...payload, window }), viewingKey) }, viewingKey);
    store.putProposal({
      ...rec, sealed: sealedWithItsWindow,
      pays: paysCommitmentOf({ vault: VAULT, asset: legFieldsOf(leg).asset, payments: recorded.map(paymentChecked) }, saltOf(rec, account, viewingKey)),
    });
  }
  const founder = newSigningKeypair();
  const state = signedFoundingState(account, { keyEpoch: 0, sealed: (await ledger.fetch(account, 0))!.sealedState }, founder.secret);
  const records = (over: Partial<CompanyRecordsHere> = {}): CompanyRecordsHere => everyRunAndProposalEntered({
    directory: async () => ({
      dir: { company: account, version: 1, seats: [{ seat: SEAT, person: 'ada', signingKey: founder.publicKey, wrappingKey: 'ab'.repeat(32), committeeKey: COMMITTEE, role: 'admin', retired: null }] },
      holders: { committee: [COMMITTEE], seats: [SEAT], approvals: 1, adoptedVaults: [], account: 'ac'.repeat(32) } as never,
      another: new Set(), at: () => null, records: heldEntering(account),
    }),
    people: async () => ({ people: hired.map((e) => ({ person: payroll.person(e.id, viewingKey)!, version: 1, handedOver: true })), notBelieved: [], notPayable: [] }),
    state: async (id) => (id === '0' ? state : null),
    runs: async () => runsFiledBy(store.listRuns(account), account, founder.secret),
    proposals: async () => store.listProposals(account),
    /* Where each proposal stands, as the person's own wallet reads this file's chain. */
    roundsOnChain: roundsOnATestChain(async () => (await ledger.status(account))?.openProposals ?? []),
    registry,
    roundIdentity: pureCircuits,
    /* Nothing made here reads what the wallet says of payments, or the company's ceilings. */
    payments: { paidOnceOf: () => { throw new Error('not read here'); }, paidMovementOf: () => { throw new Error('not read here'); }, read: async () => { throw new Error('not read here'); } },
    policy: async () => { throw new Error('not read here'); },
    ...over,
  /* Founded on the chain by the founding seat, its first anchor holding the first state. */
  }, account, [founder.secret], { seat: SEAT, signingSecret: founder.secret, records: [state], committee: [COMMITTEE] });
  return { store, accounts, payroll, account, viewingKey, runId: run.id, proposalId, records, hired, founder };
};

describe('WHAT A RAISE IS BUILT FROM, MADE HERE FROM THE COMPANY\'S RECORDS', () => {
  it('A WRITTEN-DOWN LEG\'S PAYMENTS AND ORDER ARE WHAT THE SERVICE WROTE DOWN', async () => {
    const c = await aCompany({ writtenDown: true });
    const leg = runLegOf(TEST_TOKEN, 'shielded');
    /* What the service wrote down: the leg's own recorded payments. */
    const recorded = c.payroll.requireRun(c.runId, c.viewingKey).payout![leg]!.facts;
    const service = (await c.payroll.raiseOrderOf(c.runId, c.viewingKey))!;
    const payments = await legPaymentsHere(c.records(), c.account, c.runId, c.viewingKey);
    /* RED WHEN: the payments a device checks against its vault are not the ones the service will send. */
    expect(payments).toEqual({ ...legFieldsOf(leg), payments: paymentsOnTheWire(recorded.map(paymentChecked)) });
    /* RED WHEN: an address, a seed or anything but a kind, a token and an amount is made for a check that needs only those. */
    expect(payments.payments.every((p) => Object.keys(p).sort().join() === 'amount,kind,token')).toBe(true);
    const order = await raiseOrderHere(c.records(), c.account, c.runId, c.viewingKey);
    /* RED WHEN: any part of the order - the run, the account's half, the identity or the digest - is made other than written down. */
    expect(order).toEqual({
      proposalId: service.proposalId, chainId: service.chainId,
      order: {
        circuit: 'propose',
        run: {
          root: service.run.root, payees: service.run.payees.toString(), opensAt: service.run.opensAt.toString(),
          closesAt: service.run.closesAt.toString(), vault: service.run.vault,
        },
        half: service.half, proposal: service.chainId,
      },
      pays: c.store.getProposal(service.proposalId)!.pays,
    });
    /* RED WHEN: the order carries anything but the proposal's own commitment, over exactly the payments checked, from its vault, under its salt. */
    expect(order.pays).toBe(paysCommitmentOf({ vault: VAULT, asset: payments.asset, payments: payments.payments }, service.half.proposalSalt));
    /* RED WHEN: a written-down leg is checked against the people as they are now rather than what was written down. */
    const doubted = c.records({ people: async () => ({ ...(await c.records().people()), notBelieved: [c.hired[1]!.id] }) });
    expect((await legPaymentsHere(doubted, c.account, c.runId, c.viewingKey)).payments).toEqual(payments.payments);
  });

  it('A LEG NOT YET RAISED PAYS WHAT THE DEVICE WORKS OUT FROM THE PEOPLE IT BELIEVES, THE SAME AS THE SERVICE', async () => {
    const c = await aCompany({ writtenDown: false, alsoAnotherToken: true });
    /* What the service would raise the leg over: each person's payment from its own reading of the roster. */
    const roster = (await c.payroll.runMaterialInputs(c.runId, c.viewingKey, TEST_TOKEN)).facts;
    /* RED WHEN: a leg not raised is checked against anything but each believed person's payment. */
    expect((await legPaymentsHere(c.records(), c.account, c.runId, c.viewingKey, { asset: TEST_TOKEN })).payments)
      .toEqual(paymentsOnTheWire(roster.map(paymentChecked)));
    /* RED WHEN: the leg asked for is not the leg made - a device then checks one token's payments and raises another's. */
    const other = await legPaymentsHere(c.records(), c.account, c.runId, c.viewingKey, { asset: OTHER_TEST_TOKEN });
    expect([other.asset, other.payments]).toEqual([OTHER_TEST_TOKEN, [{ kind: 'shielded', token: OTHER_TEST_TOKEN, amount: '700' }]]);
    /* RED WHEN: a run of two legs is made for without saying which. */
    await expect(legPaymentsHere(c.records(), c.account, c.runId, c.viewingKey)).rejects.toThrow();
    /* RED WHEN: a run paying somebody this device does not believe is checked as one it would raise. */
    const doubted = c.records({ people: async () => ({ ...(await c.records().people()), notBelieved: [c.hired[1]!.id] }) });
    await expect(legPaymentsHere(doubted, c.account, c.runId, c.viewingKey, { asset: TEST_TOKEN })).rejects.toThrow(/does not believe their record/u);
    /* RED WHEN: a leg with nothing written down is handed an order to build. */
    await expect(raiseOrderHere(c.records(), c.account, c.runId, c.viewingKey, { asset: TEST_TOKEN })).rejects.toThrow(NotMadeHere);
  });

  it('THE LEGS ARE THE SERVICE\'S LEGS, AND A RUN OF ANOTHER COMPANY OR A KEY THAT DOES NOT OPEN IT IS REFUSED', async () => {
    const c = await aCompany({ writtenDown: true });
    const legs = await legsHere(c.records(), c.account, c.runId, c.viewingKey);
    /* RED WHEN: a leg is named, totalled or tied to its proposal other than the service does. */
    expect(legs).toEqual(c.payroll.legsOf(c.runId, c.viewingKey));
    await expect(legsHere(c.records(), 'acc_other', c.runId, c.viewingKey)).rejects.toThrow(/records hold no payroll run by that name/u);
    await expect(legsHere(c.records(), c.account, c.runId, newSymmetricKey() as Hex)).rejects.toThrow(/cannot open this payroll run/u);
  });

  it('A PROPOSAL ALREADY SENT, OR WITHDRAWN, HAS NO ORDER TO BUILD; AND A PAGE WITHOUT THE COMPANY\'S PROPOSALS MAKES NONE', async () => {
    const c = await aCompany({ writtenDown: true });
    const rec = c.store.getProposal(c.proposalId!)!;
    /* Where the proposal stands, as the person's own wallet reads the chain: held open, or closed by the call that withdrew it. */
    const chainSays = (round: RoundOnChain) => async (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id.toLowerCase(), round]));
    const WITHDRAWN: RoundOnChain = { held: 'closed', approvals: 0, raisedAt: 1_800_000_000_000, txRef: 'ab'.repeat(32), closedBy: ['cancel'] };
    const HELD: RoundOnChain = { held: 'open', approvals: 0, raisedAt: 1_800_000_000_000, txRef: 'ab'.repeat(32) };
    /* RED WHEN: a proposal the chain shows withdrawn is handed over to be built and sent. */
    await expect(raiseOrderHere(c.records({ roundsOnChain: chainSays(WITHDRAWN) }), c.account, c.runId, c.viewingKey)).rejects.toThrow(/waiting to be sent/u);
    /* RED WHEN: a proposal the chain holds is handed over to be sent again. */
    await expect(raiseOrderHere(c.records({ roundsOnChain: chainSays(HELD) }), c.account, c.runId, c.viewingKey)).rejects.toThrow(/waiting to be sent/u);
    /* RED WHEN: the service's word that a proposal the chain never held was withdrawn, or was raised, is believed - its proof may still be sent. */
    const servedSo = c.records({ proposals: async () => [{ ...rec, status: 'cancelled' as const, raisedAt: '2026-10-07T00:00:00.000Z' }] });
    await expect(raiseOrderHere(servedSo, c.account, c.runId, c.viewingKey)).resolves.toMatchObject({ proposalId: c.proposalId });
    /* RED WHEN: a proposal written down with no commitment to what it pays is handed over to be sent, with nothing to hold the send to. */
    const silent = c.records({ proposals: async () => [{ ...rec, pays: undefined }] });
    await expect(raiseOrderHere(silent, c.account, c.runId, c.viewingKey)).rejects.toThrow(/does not say what it pays/u);
    /* RED WHEN: a withdrawn proposal's payments are taken as the leg's, so the device checks what will never be sent. */
    const doubting = { people: async () => ({ ...(await c.records().people()), notBelieved: [c.hired[1]!.id] }) };
    const cancelled = c.records({ ...doubting, roundsOnChain: chainSays(WITHDRAWN) });
    await expect(legPaymentsHere(cancelled, c.account, c.runId, c.viewingKey)).rejects.toThrow(/does not believe their record/u);
    expect((await legPaymentsHere(c.records(doubting), c.account, c.runId, c.viewingKey)).payments).toHaveLength(3);
    /* A leg the run no longer names a proposal for, raised once and whose round may still be on chain: raised again as itself. */
    const run = c.payroll.requireRun(c.runId, c.viewingKey);
    const sealed = c.store.listRuns(c.account).find((x) => x.id === c.runId)!;
    const { employees, totals, payout, skips, repeats } = run;
    const unnamed = { ...sealed, proposalIds: [], sealed: sealRecord('payroll', c.account, { employees, totals, proposalIds: {}, payout, skips, repeats }, c.viewingKey) };
    const earlier = (round: RoundOnChain) =>
      c.records({ ...doubting, runs: async () => runsFiledBy([unnamed as SealedRun], c.account, c.founder.secret), roundsOnChain: chainSays(round) });
    /* RED WHEN: a leg whose earlier round may be on chain is checked against the people now, so raising it again raises another round. */
    expect((await legPaymentsHere(earlier(HELD), c.account, c.runId, c.viewingKey)).payments).toHaveLength(3);
    /* The leg's own round, which the chain never held: its proof may still be sent while its window is open, and nothing can pay against it after. */
    const NEVER: RoundOnChain = { held: 'never', approvals: 0 };
    const unheld = c.records({ ...doubting, roundsOnChain: chainSays(NEVER) });
    /* RED WHEN: a round the chain never held is taken as withdrawn while its window is still open. */
    expect((await legPaymentsHere(unheld, c.account, c.runId, c.viewingKey)).payments).toHaveLength(3);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((NOW + 3_600) * 1000);
    try {
      /* RED WHEN: a round the chain never held still decides what the leg pays once its window has closed. */
      await expect(legPaymentsHere(unheld, c.account, c.runId, c.viewingKey)).rejects.toThrow(/does not believe their record/u);
    } finally {
      vi.useRealTimers();
    }
    /* RED WHEN: an earlier round the chain shows withdrawn still decides what the leg pays. */
    await expect(legPaymentsHere(earlier(WITHDRAWN), c.account, c.runId, c.viewingKey)).rejects.toThrow(/does not believe their record/u);
    await expect(raiseOrderHere(c.records({ proposals: undefined }), c.account, c.runId, c.viewingKey)).rejects.toThrow(/cannot read the company's proposals/u);
  });
});

describe('WHAT A RETRY IS BUILT FROM, MADE HERE FROM THE LEG IT RETRIES', () => {
  /** The written-down run with a retry of its second and third people on the leg, as a retry is written onto it. */
  const withARetry = async () => {
    const c = await aCompany({ writtenDown: true });
    const sealed = c.store.listRuns(c.account).find((r) => r.id === c.runId)! as SealedRun;
    const run = c.payroll.requireRun(c.runId, c.viewingKey);
    const leg = Object.keys(run.payout!)[0]! as keyof NonNullable<typeof run.payout>;
    const payout = run.payout![leg]!;
    /* The retry's own proposal, written down under its own identity and its own salt, beside the leg's. */
    const legRec = c.store.getProposal(c.proposalId!)!;
    const envelope = openRecord<{ sealedPayload: Sealed } & Record<string, unknown>>('proposals', c.account, legRec.sealed, c.viewingKey);
    const payload = parseCanonical<{ __change: Record<string, unknown> } & Record<string, unknown>>(unseal(envelope.sealedPayload, c.viewingKey));
    const RETRY_SALT = '5c'.repeat(32);
    const retryRec: SealedProposal = {
      ...legRec, id: 'prp_retry', chainId: 'cd'.repeat(32) as Hex,
      pays: paysCommitmentOf({ vault: payout.vault, asset: legFieldsOf(leg).asset, payments: [2, 1].map((i) => paymentChecked(payout.facts[i]!)) }, RETRY_SALT),
      sealed: sealRecord('proposals', c.account, {
        ...envelope, sealedPayload: seal(canonical({ ...payload, __change: { ...payload.__change, salt: RETRY_SALT } }), c.viewingKey),
      }, c.viewingKey),
    };
    const retryId = retryRec.id;
    const retried = {
      ...run, payout: { [leg]: { ...payout, retries: [{ originalIndices: [2, 1], root: payout.root, payees: payout.payees, opensAt: 5n, closesAt: 6n, vault: payout.vault, proposalId: retryId, proposedBy: 's', at: 'now' }] } },
    };
    const { employees, totals, proposalIds, payout: p, skips, repeats } = retried;
    const resealed = { ...sealed, proposalIds: proposalListOf({ proposalIds, payout: p }), sealed: sealRecord('payroll', c.account, { employees, totals, proposalIds, payout: p, skips, repeats }, c.viewingKey) };
    return {
      ...c, retryId, RETRY_SALT, payout,
      records: (over: Partial<CompanyRecordsHere> = {}) => c.records({ runs: async () => runsFiledBy([resealed], c.account, c.founder.secret), proposals: async () => [legRec, retryRec], ...over }),
    };
  };

  it('A RETRY PAYS THE LEG\'S RECORDED PAYMENT OF EACH PERSON IT NAMES, IN ITS ORDER, AND ITS ORDER IS THE RETRY\'S OWN', async () => {
    const c = await withARetry();
    const retry = await retryPaymentsHere(c.records(), c.account, c.runId, c.viewingKey, [2, 1]);
    /* RED WHEN: a retry is checked with the leg's payments, or in another order. */
    expect(retry.payments.map((x) => x.amount)).toEqual([c.payout.facts[2]!.amount, c.payout.facts[1]!.amount].map(String));
    const order = await retryOrderHere(c.records(), c.account, c.runId, c.viewingKey, c.retryId);
    /* RED WHEN: the retry's window or people are taken from anything but the retry as the leg records it. */
    expect([order.order.run.opensAt, order.order.run.closesAt, order.indices]).toEqual(['5', '6', [2, 1]]);
    /* RED WHEN: the retry is built under the leg's own proposal - its identity or its salt - rather than its own. */
    expect([order.proposalId, order.chainId, order.order.proposal, order.order.half.proposalSalt]).toEqual(['prp_retry', 'cd'.repeat(32), 'cd'.repeat(32), c.RETRY_SALT]);
    /* RED WHEN: the retry's order carries anything but its own proposal's commitment, over exactly the retry's payments. */
    expect(order.pays).toBe(paysCommitmentOf({ vault: c.payout.vault, asset: retry.asset, payments: retry.payments }, c.RETRY_SALT));
    for (const [why, indices] of [['nobody', []], ['a person twice', [1, 1]], ['a person not on the leg', [3]], ['a position that is not one', [-1]]] as const) {
      /* RED WHEN: a retry naming nobody, somebody twice or somebody not on the leg is checked as a retry. */
      await expect(retryPaymentsHere(c.records(), c.account, c.runId, c.viewingKey, [...indices]), why).rejects.toThrow(NotMadeHere);
    }
    /* RED WHEN: a retry this leg does not record is handed an order to build. */
    await expect(retryOrderHere(c.records(), c.account, c.runId, c.viewingKey, 'prp_none')).rejects.toThrow(/waiting to be sent/u);
    /* RED WHEN: a proposal written down and waiting, but not as a retry of this leg - the leg's own - is built as the retry. */
    await expect(retryOrderHere(c.records(), c.account, c.runId, c.viewingKey, c.proposalId!)).rejects.toThrow(/waiting to be sent/u);
  });
});

describe('WHAT CARRIES OUT A SEAT OR A THRESHOLD CHANGE', () => {
  it('IS MADE FROM THE PROPOSAL AS THIS DEVICE OPENED IT, AND NOTHING ELSE IS CARRIED OUT FROM HERE', () => {
    const opened = { chainId: 'c1'.repeat(32), digest: '', vault: '', salt: 'a1'.repeat(32), summary: '' };
    /* RED WHEN: the leaf, the threshold, the identity or the salt carried out is not the opened proposal's. */
    expect(carryOrderHere({ ...opened, governance: { kind: 'add-signer', leaf: 'ab'.repeat(32) } }))
      .toEqual({ circuit: 'amendSigner', leaf: 'ab'.repeat(32), proposal: opened.chainId, proposalSalt: opened.salt });
    expect(carryOrderHere({ ...opened, governance: { kind: 'threshold', threshold: '2' } }))
      .toEqual({ circuit: 'setThreshold', threshold: '2', proposal: opened.chainId, proposalSalt: opened.salt });
    /* RED WHEN: a run or a vault adoption is carried out as if it were a seat. */
    expect(() => carryOrderHere(opened)).toThrow(NotMadeHere);
    expect(() => carryOrderHere({ ...opened, governance: { kind: 'adopt-vault', vault: 'cd'.repeat(32) } })).toThrow(NotMadeHere);
  });
});

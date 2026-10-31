import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import type { PayrollRun } from '../core/types.js';
import { newProposalId } from '../core/proposal-filing.js';
import { assetIdHex, TEST_SETTLEMENT_ASSET, type AssetId } from '../core/assets.js';
import { canonical, newWrappingKeypair, randomBytes, seal, signingPublicKeyOf, toHex, type Hex } from '../core/crypto.js';
import { purposeKey } from '../core/sealed-records.js';
import { newOneOffSeed, ONE_OFF_KIND, ONE_OFF_PURPOSE, ONE_OFF_SEALED_BYTES } from '../midnight/one-off-record.js';
import { signCompanyFiling, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import { companyRecordEntry } from '../midnight/record-manifest.js';
import { buildRetryRun, buildRun, paidMovementOfLeaf, paidOnceOfNonce, rootOfPayments } from '../midnight/payout-tree.js';
import { theNetwork } from '../midnight/network.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import { payeeFor } from '../testing/payees.js';
import { aVaultHolding, TEST_TOKEN } from '../testing/assets.js';
import { vaultDetails } from '../testing/vault-details.js';
import { anchoredOver } from '../testing/record-tree-double.js';
import { oneOffHere, oneOffsHere } from 'vaults-web-shared/one-off-here.js';
import { HttpCompanyRecordStore } from 'vaults-web-shared/http-sealed-pool-store.js';
import { raiseOneOffHere } from 'vaults-web-shared/one-off-raised-here.js';
import { checkedAgainstTheRecordsAndTheWallet, type CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { RAISE_CHECKS } from 'vaults-web-shared/raise-checks-here.js';
import { approveOnDevice, governedCallServiceFor, raiseRunOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import type { LegRaiseDoors } from 'vaults-web-shared/run-raised-here.js';
import { drawRunHere } from 'vaults-web-shared/run-drawn-here.js';
import { legToPayHere } from 'vaults-web-shared/payments-made-here.js';
import { chargeTheRunHere, type ChargeDoors, type ChargeInFlight } from 'vaults-web-shared/run-charged-here.js';
import { inFlightInMemory, sealedOnThisDevice } from 'vaults-web-shared/in-flight-on-this-device.js';
import { checkedHeadsInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { directoryHere, judgeIn } from 'vaults-web-shared/vault-page-doors.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { acceptAsPayeeHere, inviteHere, openInvitationHere } from 'vaults-web-shared/invitation-on-device.js';
import { admitHere, readPeopleHere, type PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import { signedClaimRefusal } from 'vaults-web-shared/signed-claim-refusal.js';
import { ACME, acmeDirectory, acmeDirectoryDeps, fromAda, ORIGIN } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, acmeChain, ADA, ADDRESS, BO, anchorDoorsOf, aPolicyFiledBy, api, apiAs, attestedByTheRoster, chargedOnChain, CO, CY,
  deviceOf, directoryOf, KEY, LABEL, oneOffRaiseDoorsOf, oneOffRecordsOf, paidOnChain, recordsSecretOf, sendAs, store, VAULT, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

const { pureCircuits } = await import('../../contracts/managed/contract/index.js');

/**
 * A one-off payment is paid while the company's directory, as the raising device read it, did not yet hold Cy's seat:
 * Cy is the signer seated after it. Cy's own device must still account for it as the company's - the two entries the
 * account recorded when it was paid, and its tree in the vault's period - or Cy could never raise or approve payroll,
 * or charge from that vault in that period, again.
 *
 * The chain here is the test's: it counts approvals and records that a charge was relayed to it, and it neither proves
 * a charge nor sums the vault's period itself. What the real account's `clearRun` checks of the period total Cy's device
 * hands it is not covered here.
 */

aCompanyWhoseSignersChange();

const NOW = BigInt(Math.floor(Date.now() / 1000));

/** A one-off from the vault, raised by Ada's device reading a directory that does not yet hold Cy's seat, then paid on the test's chain. */
const aOneOffPaidBeforeCyWasSeated = async (asset: AssetId, reason: string) => {
  const before = oneOffRaiseDoorsOf(ADA);
  const withoutCy: typeof before.records.directory = async (asked) => {
    const here = await before.records.directory(asked);
    return { ...here, dir: { ...here.dir, seats: here.dir.seats.filter((x) => x.seat !== CY.seat) } };
  };
  const round = await raiseOneOffHere({ ...before, records: { ...before.records, directory: withoutCy } }, {
    vault: VAULT, asset, amount: 77n, form: 'private',
    payee: { ref: null, name: null, address: payeeFor('c9'.repeat(32), 'undeployed').bech32, network: 'undeployed' },
    reason, opensAt: NOW - 60n, closesAt: NOW + 86_400n, viewingKey: KEY,
  });
  const raised = (await oneOffsHere(oneOffRecordsOf(ADA), CO)).believed.find((o) => o.oneOff.proposal.id === round.id)!;
  /* The one-off is paid: the account records its once-mark and its leaf's movement. */
  paidOnChain.add(paidOnceOfNonce(raised.secrets.nonce).toLowerCase());
  paidOnChain.add(paidMovementOfLeaf(raised.tree.tree.leaves[0]!).toLowerCase());
  return raised;
};

/* ── payroll on the same company: its people, its runs, and a device's records of both ── */

const NETWORK = theNetwork();
const peopleOn = (s: Seat): PeopleDevice => ({
  company: ACME, signingSecret: s.signingSecret, signedInAs: s.person, send: sendAs(s.person), directory: acmeDirectory, network: NETWORK, claimRefusal: signedClaimRefusal,
  entered: s.entered,
});
/** A payee invited by Ada, who accepts and is admitted: paid in the test's settlement currency, as payroll pays. */
const aPayee = async (n: number): Promise<void> => {
  const address = payeeFor(n.toString(16).padStart(2, '0').repeat(32), NETWORK).bech32;
  const code: JoinCode = signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), LABEL, `usr_${n}`, { kind: 'payee', address, payslipKey: newWrappingKeypair().publicKey });
  const made = await inviteHere(ACME, ADA, 'employee', {
    name: `Payee ${n}`, email: `payee${n}@acme.co`, title: 'Engineer', asset: TEST_SETTLEMENT_ASSET, baseAmount: 700000n + BigInt(n), classification: 'full-time' as const, startDate: '2026-10-01',
  }, ORIGIN, fromAda);
  const accepted = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs(`usr_${n}`));
  const here = (await readPeopleHere(peopleOn(ADA))).people.find((p) => p.person.id === made.person)!;
  await admitHere(peopleOn(ADA), here, accepted.fingerprint);
};
/** Where each seat's device keeps the heads of the company's records it checked. */
const checkedBy = new Map<string, ReturnType<typeof checkedHeadsInMemory>>();
/** `s`'s device's whole company records: its directory, its people and runs, and the one-offs and payments it reads. */
const payrollRecordsOf = (s: Seat): CompanyRecordsHere & { readonly proposals: () => Promise<ReturnType<typeof store.listProposals>> } => {
  const checked = checkedBy.get(s.seat) ?? checkedBy.set(s.seat, checkedHeadsInMemory()).get(s.seat)!;
  const directory = (asked?: RecordsAsked) => directoryHere({
    ...acmeDirectoryDeps(), attested: attestedByTheRoster(s), anchored: anchoredOver(apiAs('ada'), CO, acmeChain.read, undefined, undefined, checked),
  }, asked);
  return {
    ...oneOffRecordsOf(s),
    directory,
    people: () => readPeopleHere(peopleOn(s)),
    runs: async () => store.listRuns(CO),
    proposals: async () => store.listProposals(CO),
    checked: async () => { await directory(); return checked.read(CO); },
    roundIdentity: pureCircuits as never,
    policy: async () => ({ threshold: 1, limitsByRole: {} }) as never,
  };
};
const raisingOn = (s: Seat): LegRaiseDoors => {
  const device = deviceOf(s);
  return {
    service: device.service, builder: device.builder as never, material: device.material as never, accountId: CO,
    records: payrollRecordsOf(s), holdings: aVaultHolding(),
    filing: { seat: s.seat, keyEpoch: 0, salt: () => toHex(randomBytes(32)), newId: () => newProposalId() },
    company: { account: ADDRESS, label: LABEL },
    runs: {
      detailsOf: vaultDetails, runPayload: pureCircuits.runPayload, proposalIdOf: pureCircuits.proposalIdOf, noVault: pureCircuits.noVault,
      retrySaltOf: pureCircuits.retrySaltOf, buildRun, buildRetryRun, rootOfPayments,
    },
    waitMs: 50, everyMs: 10, sleep: async () => undefined,
    recorded: { entered: s.entered, anchor: () => anchorTheRecordsHere(anchorDoorsOf(s)) },
  };
};
/** What a device builds a charge of a run with: the contract's own circuits, and nobody yet recorded paid. */
const PAYING = {
  detailsOf: vaultDetails, runPayload: pureCircuits.runPayload, proposalIdOf: pureCircuits.proposalIdOf, paidAmong: async () => null,
};
/** Every charge `s`'s vault worker was asked to build, as it was asked. */
const clearRunsAsked: Array<Parameters<ChargeDoors['builder']['clearRun']>[0]> = [];
/**
 * `s`'s device as it charges a run: its vault worker stood in - it builds the charge as a transaction the test's chain
 * reads, and proves nothing - and the charge relayed through the service's own route to the test's chain.
 */
const chargingOn = (s: Seat, records: CompanyRecordsHere) => ({
  records, accountId: CO, viewingKey: KEY, account: ADDRESS as never,
  indexer: async () => ({ indexerUri: 'http://indexer.test', indexerWsUri: 'ws://indexer.test' }),
  builder: {
    chainAtOneBlock: async () => ({ accountState: 'AS', parameters: 'PP', vaultState: '', zswapState: '', blockHash: 'b' }),
    eventsOf: async () => { throw new Error('no events are read in this test'); },
    createdBy: async () => { throw new Error('no vault is read in this test'); },
    clearRun: async (input: Parameters<ChargeDoors['builder']['clearRun']>[0]) => {
      clearRunsAsked.push(input);
      return { tx: Buffer.from(JSON.stringify({ signer: s.seat, order: { circuit: 'clearRun', proposal: input.run.proposal } })).toString('base64'), spent: '0' };
    },
    periodTotal: async () => { throw new Error('no period total is read in this test'); },
    runCharged: async (input: { proposal: string }) => (chargedOnChain.has(String(input.proposal).toLowerCase()) ? 'charged' : 'open'),
  },
  charge: (id: string, body: { tx: string; filer: string }) => governedCallServiceFor(api(s.person)).charge!(id, body),
  filer: signingPublicKeyOf(s.signingSecret as Hex) as Hex,
  chargesInFlight: sealedOnThisDevice<ChargeInFlight>(inFlightInMemory(), { signerId: s.seat, wrappingSecret: recordsSecretOf(s) as never }, 'charge'),
  sleep: async () => undefined, waitMs: 40, everyMs: 1,
}) as unknown as Parameters<typeof chargeTheRunHere>[0];

/**
 * A version 2 of the one-off filed as `id`, put by `by`'s seat: what it seals is made as the record's own seal makes a
 * one-off, with its label naming version 2, another amount and another seed - so it opens as a one-off of its own.
 */
const aSecondVersionPutBy = async (by: Seat, id: string, first: { readonly oneOff: Parameters<typeof canonical>[0] & Record<string, any> }): Promise<SealedCompanyRecord> => {
  const o = first.oneOff;
  const text = canonical({
    vault: o.vault, asset: o.asset, amount: '5',
    payee: { ref: null, name: o.payee.name, address: o.payee.address, network: o.payee.network },
    reason: o.reason, proposal: o.proposal,
    run: { opensAt: o.run.opensAt.toString(), closesAt: o.run.closesAt.toString(), required: o.run.required.toString() },
    seed: newOneOffSeed(), $label: { record: ONE_OFF_KIND, company: CO, id, version: 2 },
  });
  const rec: SealedCompanyRecord = {
    company: CO, kind: ONE_OFF_KIND, id, version: 2, keyEpoch: 0, wrapped: [],
    sealed: seal(text + ' '.repeat(ONE_OFF_SEALED_BYTES - new TextEncoder().encode(text).length), purposeKey(KEY, CO, ONE_OFF_PURPOSE)),
  };
  await new HttpCompanyRecordStore(CO, (path, init) => sendAs(by.person)(path, init as never), by.signingSecret as Hex,
    async (asked) => judgeIn(await directoryOf(by)(asked))).put(rec);
  const signed = signCompanyFiling(rec, by.signingSecret as Hex);
  await by.entered.enter([companyRecordEntry(signed)]);
  await anchorTheRecordsHere(anchorDoorsOf(by));
  return signed;
};

/** The vault's policy for the settlement currency: one period holding both the one-off's window and the run's, and two approvals a run. */
const ONE_PERIOD = {
  bands: [
    { ceiling: '1000000000', approvals: '2' }, { ceiling: '2000000000', approvals: '2' }, { ceiling: '3000000000', approvals: '2' }, { ceiling: '4000000000', approvals: '3' },
  ],
  periodLimit: '100000000000', periodStart: String(NOW - 3_600n), periodLength: '864000',
};

describe('A SIGNER SEATED AFTER A ONE-OFF WAS PAID STILL RAISES, APPROVES AND CHARGES PAYROLL', () => {
  it('CY\'S DEVICE OPENS THE ONE-OFF RAISED BEFORE CY WAS SEATED, COUNTS ITS ENTRIES AS THE COMPANY\'S, AND SUMS IT IN ITS PERIOD', async () => {
    const raised = await aOneOffPaidBeforeCyWasSeated(TEST_TOKEN, 'Invoice 2026-120');

    const cys = oneOffRecordsOf(CY);
    const read = await oneOffsHere(cys, CO);
    /* RED WHEN: a signer seated after a one-off cannot open it, so their device cannot say what the company paid from its vault in the period. */
    expect(read.unread).toEqual([]);
    expect(read.believed.find((o) => o.id === raised.id)?.tree.tree.root).toBe(raised.tree.tree.root);

    const made = await checkedAgainstTheRecordsAndTheWallet(cys, CO, { period: '2026-10' } as PayrollRun, KEY, {
      kind: 'payroll', seeds: [], payKey: '00'.repeat(32), identity: { accountId: CO, runId: 'run_x', epoch: 0 }, facts: [], records: [], asset: TEST_TOKEN,
      opensAt: '0', closesAt: '1', required: '0',
    });
    const unaccounted = RAISE_CHECKS.find((c) => c.name === 'unaccounted')!;
    /* RED WHEN: the paid one-off's two entries are unaccounted on Cy's device, which then refuses every payroll raise and approval. */
    expect(() => unaccounted.check({ made } as never, { circuits: cys.payments } as never)).not.toThrow();
  }, 170_000);

  it('CY APPROVES ON ITS OWN DEVICE A PAYROLL RUN ADA RAISED FROM THAT VAULT, AND BUILDS ITS CHARGE AGAINST A PERIOD THAT HOLDS THE ONE-OFF AND RELAYS IT; THE TEST\'S CHAIN ONLY RECORDS THE CHARGE, AND NEITHER PROVES IT NOR SUMS THE PERIOD', async () => {
    /* The vault's policy, sealed to the seats before Cy's; the one-off is raised and paid under it. */
    await aPolicyFiledBy(ADA, [ADA, BO], { terms: ONE_PERIOD, asset: TEST_SETTLEMENT_ASSET });
    const raised = await aOneOffPaidBeforeCyWasSeated(TEST_SETTLEMENT_ASSET, 'Invoice 2026-121');
    /* Cy is seated: the policy is filed again, sealed to Cy's seat too, so Cy's device reads it. */
    await aPolicyFiledBy(ADA, [ADA, BO, CY], { terms: ONE_PERIOD, asset: TEST_SETTLEMENT_ASSET });
    await aPayee(61);
    await aPayee(62);
    const runId = (await drawRunHere({
      api: api(ADA.person), accountId: CO, viewingKey: KEY, keyEpoch: 0, signingSecret: ADA.signingSecret as Hex, company: { account: ADDRESS, label: LABEL },
      records: payrollRecordsOf(ADA) as never, by: ADA.person, entered: ADA.entered,
    }, { period: '2031-01' })).id;
    const round = await raiseRunOnDevice(raisingOn(ADA), {
      runId, viewingKey: KEY, vault: VAULT, opensAt: String(NOW + 3_600n), closesAt: String(NOW + 7_200n),
    });

    const cys = payrollRecordsOf(CY);
    /* RED WHEN: Cy's device, approving, finds the paid one-off's entries unaccounted (round-opened-here's check of what no round may), and refuses. */
    const approved = await approveOnDevice({ ...deviceOf(CY), records: cys }, { round, viewingKey: KEY });
    expect(approved.approvalCount).toBe(2);

    const toPay = await legToPayHere(cys, CO, runId, KEY, PAYING);
    const charged = await chargeTheRunHere(chargingOn(CY, cys), toPay);
    const asked = clearRunsAsked.find((a) => a.run.proposal === toPay.order.proposal)!;
    /* RED WHEN: the period Cy's device charges the run against leaves the paid one-off out, so the chain would sum less than the vault paid. */
    expect(asked.runs.map((r) => r.root)).toContain(raised.tree.tree.root);
    expect(asked.run.asset).toBe(assetIdHex(TEST_SETTLEMENT_ASSET).toLowerCase());
    /* RED WHEN: the charge Cy's device built is not relayed to the chain through the service's charge route. */
    expect(chargedOnChain.has(String(toPay.order.proposal).toLowerCase())).toBe(true);
    expect(charged.state).toBe('charged');
  }, 170_000);

  it('A ONE-OFF IS FILED ONCE: A VERSION 2 ANOTHER SEAT PUTS OVER A PAID ONE-OFF IS NOT BELIEVED, AND PAYROLL FROM THAT VAULT STILL RAISES, APPROVES AND CHARGES', async () => {
    await aPolicyFiledBy(ADA, [ADA, BO, CY], { terms: ONE_PERIOD, asset: TEST_SETTLEMENT_ASSET });
    /* Cy's device raises and files the one-off, enters it and anchors it; it is paid. */
    const round = await raiseOneOffHere(oneOffRaiseDoorsOf(CY), {
      vault: VAULT, asset: TEST_SETTLEMENT_ASSET, amount: 88n, form: 'private',
      payee: { ref: null, name: null, address: payeeFor('ca'.repeat(32), 'undeployed').bech32, network: 'undeployed' },
      reason: 'Invoice 2026-122', opensAt: NOW - 60n, closesAt: NOW + 86_400n, viewingKey: KEY,
    });
    const first = (await oneOffsHere(oneOffRecordsOf(CY), CO)).believed.find((o) => o.oneOff.proposal.id === round.id)!;
    paidOnChain.add(paidOnceOfNonce(first.secrets.nonce).toLowerCase());
    paidOnChain.add(paidMovementOfLeaf(first.tree.tree.leaves[0]!).toLowerCase());
    /* Bo's seat, which may file one-offs, puts a version 2 under its id, enters it and anchors it. */
    await aSecondVersionPutBy(BO, first.id, first as never);

    const adas = oneOffRecordsOf(ADA);
    const read = await oneOffHere({ accountId: CO, directory: adas.directory, records: adas.oneOffs, keys: KEY, registry: adas.oneOffs.registry!, open: adas.oneOffs.open }, first.id);
    /* RED WHEN: a device believes a later version of a one-off, so another seat can change what a paid one-off paid. */
    expect(read).toMatchObject({ state: 'read', version: 1, oneOff: { amount: 88n, seed: first.oneOff.seed } });
    expect((await oneOffsHere(adas, CO)).believed.find((o) => o.id === first.id)?.tree.tree.root).toBe(first.tree.tree.root);

    await aPayee(63);
    const runId = (await drawRunHere({
      api: api(ADA.person), accountId: CO, viewingKey: KEY, keyEpoch: 0, signingSecret: ADA.signingSecret as Hex, company: { account: ADDRESS, label: LABEL },
      records: payrollRecordsOf(ADA) as never, by: ADA.person, entered: ADA.entered,
    }, { period: '2031-02' })).id;
    /* RED WHEN: the paid version 1's two entries are unaccounted once a version 2 is put, and every payroll raise from the vault is refused. */
    const raised = await raiseRunOnDevice(raisingOn(ADA), {
      runId, viewingKey: KEY, vault: VAULT, opensAt: String(NOW + 7_200n), closesAt: String(NOW + 10_800n),
    });
    const cys = payrollRecordsOf(CY);
    expect((await approveOnDevice({ ...deviceOf(CY), records: cys }, { round: raised, viewingKey: KEY })).approvalCount).toBe(2);
    const toPay = await legToPayHere(cys, CO, runId, KEY, PAYING);
    expect((await chargeTheRunHere(chargingOn(CY, cys), toPay)).state).toBe('charged');
    /* RED WHEN: the period the run is charged against holds the later version's tree in place of the one-off that was paid. */
    expect(clearRunsAsked.find((a) => a.run.proposal === toPay.order.proposal)!.runs.map((r) => r.root)).toContain(first.tree.tree.root);
  }, 170_000);
});

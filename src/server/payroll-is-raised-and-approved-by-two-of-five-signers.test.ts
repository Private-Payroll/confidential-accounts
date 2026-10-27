/**
 * **PAYROLL IS DRAWN, RAISED, APPROVED AND CHARGED BY TWO OF A COMPANY'S FIVE SIGNERS, AND NO REQUEST IS SENT TO THE
 * SERVICE AS ANY OF THE OTHER THREE.** Ada draws and raises the run on her device, which counts as her approval; Bo
 * approves on his and charges it to the vault's period. Cy, Dee and Eli are seated signers who do nothing: a request
 * sent as any of them throws, and the service is sent requests as Ada and Bo only, so nothing of theirs - no device,
 * no key, no handover - is needed for the company's payroll. The two comes from the vault's spending policy, whose
 * band asks two approvals of the run (`required`) above an account threshold of one.
 *
 * Over real HTTP, with the people invited, accepted and admitted on devices. The chain is the test's stand-in: it
 * counts the raiser's approval at every raise of a run, counts approvals by who sent them, takes a charge without
 * counting them, and runs none of the contract's circuits, so it is not shown here that the chain saw nothing from
 * Cy, Dee or Eli, only that no request was sent as them. Both routes to a bar of two - a band's `required` above an
 * account threshold of one, and an account threshold of two - against the contract itself are
 * contracts/test/payroll-is-approved-by-two-of-five-seats.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode, type JoinCode } from 'midnight-identity/profile/join-code';
import { newProposalId } from '../core/proposal-filing.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { newWrappingKeypair, randomBytes, signingPublicKeyOf, toHex, type Hex } from '../core/crypto.js';
import { buildRetryRun, buildRun, rootOfPayments } from '../midnight/payout-tree.js';
import { theNetwork } from '../midnight/network.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import { payeeFor } from '../testing/payees.js';
import { aVaultHolding } from '../testing/assets.js';
import { vaultDetails } from '../testing/vault-details.js';
import { anchoredOver } from '../testing/record-tree-double.js';
import type { CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { approveOnDevice, governedCallServiceFor, raiseRunOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import type { LegRaiseDoors } from 'vaults-web-shared/run-raised-here.js';
import { drawRunHere } from 'vaults-web-shared/run-drawn-here.js';
import { legToPayHere } from 'vaults-web-shared/payments-made-here.js';
import { chargeTheRunHere, type ChargeInFlight } from 'vaults-web-shared/run-charged-here.js';
import { inFlightInMemory, sealedOnThisDevice } from 'vaults-web-shared/in-flight-on-this-device.js';
import { checkedHeadsInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { directoryHere } from 'vaults-web-shared/vault-page-doors.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { acceptAsPayeeHere, inviteHere, openInvitationHere } from 'vaults-web-shared/invitation-on-device.js';
import { admitHere, readPeopleHere, type PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import { ACME, acmeDirectory, acmeDirectoryDeps, askedBy, fromAda, offline, ORIGIN } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, acmeChain, ADA, ADDRESS, BO, anchorDoorsOf, aPolicyFiledBy, api, apiAs, attestedByTheRoster, chargedOnChain, CO, CY,
  deviceOf, KEY, LABEL, oneOffRecordsOf, recordsSecretOf, seatOf, seatsOnTheChain, sendAs, store, VAULT, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

const { pureCircuits } = await import('../../contracts/managed/contract/index.js');

const DEE = seatOf('dee', 4, LABEL, ADDRESS, CO, ADA);
const ELI = seatOf('eli', 5, LABEL, ADDRESS, CO, ADA);
aCompanyWhoseSignersChange(2, [DEE, ELI]);

const NOW = BigInt(Math.floor(Date.now() / 1000));
const NETWORK = theNetwork();
const peopleOn = (s: Seat): PeopleDevice => ({
  company: ACME, signingSecret: s.signingSecret, signedInAs: s.person, send: sendAs(s.person), directory: acmeDirectory, network: NETWORK,
  entered: s.entered,
});
/** A payee invited by Ada, who accepts and is admitted. */
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
const checkedBy = new Map<string, ReturnType<typeof checkedHeadsInMemory>>();
/** `s`'s device's whole company records: its directory, its people and runs, and the one-offs and payments it reads. */
const payrollRecordsOf = (s: Seat): CompanyRecordsHere & { readonly proposals: () => Promise<ReturnType<typeof store.listProposals>> } => {
  const checked = checkedBy.get(s.seat) ?? checkedBy.set(s.seat, checkedHeadsInMemory()).get(s.seat)!;
  const directory = (asked?: RecordsAsked) => directoryHere({
    ...acmeDirectoryDeps(), attested: attestedByTheRoster(s), anchored: anchoredOver(apiAs(s.person), CO, acmeChain.read, undefined, undefined, checked),
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
/** `s`'s device as it charges a run: its vault worker stood in, and the charge relayed through the service's own route. */
const chargingOn = (s: Seat, records: CompanyRecordsHere) => ({
  records, accountId: CO, viewingKey: KEY, account: ADDRESS as never,
  indexer: async () => ({ indexerUri: 'http://indexer.test', indexerWsUri: 'ws://indexer.test' }),
  builder: {
    chainAtOneBlock: async () => ({ accountState: 'AS', parameters: 'PP', vaultState: '', zswapState: '', blockHash: 'b' }),
    eventsOf: async () => { throw new Error('no events are read in this test'); },
    createdBy: async () => { throw new Error('no vault is read in this test'); },
    clearRun: async (input: { run: { proposal: string } }) => ({
      tx: Buffer.from(JSON.stringify({ signer: s.seat, order: { circuit: 'clearRun', proposal: input.run.proposal } })).toString('base64'), spent: '0',
    }),
    periodTotal: async () => { throw new Error('no period total is read in this test'); },
    runCharged: async (input: { proposal: string }) => (chargedOnChain.has(String(input.proposal).toLowerCase()) ? 'charged' : 'open'),
  },
  charge: (id: string, body: { tx: string; filer: string }) => governedCallServiceFor(api(s.person)).charge!(id, body),
  filer: signingPublicKeyOf(s.signingSecret as Hex) as Hex,
  chargesInFlight: sealedOnThisDevice<ChargeInFlight>(inFlightInMemory(), { signerId: s.seat, wrappingSecret: recordsSecretOf(s) as never }, 'charge'),
  sleep: async () => undefined, waitMs: 40, everyMs: 1,
}) as unknown as Parameters<typeof chargeTheRunHere>[0];
const PAYING = { detailsOf: vaultDetails, runPayload: pureCircuits.runPayload, proposalIdOf: pureCircuits.proposalIdOf, paidAmong: async () => null };
/** The vault's policy for the settlement currency: one period holding the run's window, and two approvals a run. */
const TWO_APPROVALS = {
  bands: [
    { ceiling: '1000000000', approvals: '2' }, { ceiling: '2000000000', approvals: '2' }, { ceiling: '3000000000', approvals: '2' }, { ceiling: '4000000000', approvals: '2' },
  ],
  periodLimit: '100000000000', periodStart: String(NOW - 3_600n), periodLength: '864000',
};

describe('TWO OF FIVE SIGNERS RUN THE PAYROLL, AND THE SERVICE IS SENT NOTHING AS THE OTHER THREE', () => {
  it('Ada draws and raises the run, Bo approves and charges it, at two approvals, with no request sent as Cy, Dee or Eli', async () => {
    expect(seatsOnTheChain()).toHaveLength(5);
    await aPolicyFiledBy(ADA, [ADA, BO, CY, DEE, ELI], { terms: TWO_APPROVALS, asset: TEST_SETTLEMENT_ASSET });
    await aPayee(81);
    await aPayee(82);
    const from = askedBy.length;
    for (const s of [CY, DEE, ELI]) offline.add(s.person);
    try {
      const run = await drawRunHere({
        api: api(ADA.person), accountId: CO, viewingKey: KEY, keyEpoch: 0, signingSecret: ADA.signingSecret as Hex, company: { account: ADDRESS, label: LABEL },
        records: payrollRecordsOf(ADA) as never, by: ADA.person, entered: ADA.entered,
      }, { period: '2031-02' });
      const round = await raiseRunOnDevice(raisingOn(ADA), { runId: run.id, viewingKey: KEY, vault: VAULT, opensAt: String(NOW + 3_600n), closesAt: String(NOW + 7_200n) });
      /* RED WHEN: the device stops reporting the raised run with the one approval the stand-in chain recorded for the raiser. The chain's own
       * counting of the raiser's approval is pinned against the contract in contracts/test/payroll-is-approved-by-two-of-five-seats.test.ts. */
      expect(round.approvalCount).toBe(1);
      const bos = payrollRecordsOf(BO);
      const approved = await approveOnDevice({ ...deviceOf(BO), records: bos }, { round, viewingKey: KEY });
      expect(approved.approvalCount).toBe(2);
      const toPay = await legToPayHere(bos, CO, run.id, KEY, PAYING);
      const charged = await chargeTheRunHere(chargingOn(BO, bos), toPay);
      expect(charged.state).toBe('charged');
      expect(chargedOnChain.has(String(toPay.order.proposal).toLowerCase())).toBe(true);
    } finally {
      for (const s of [CY, DEE, ELI]) offline.delete(s.person);
    }
    /* RED WHEN: any step of drawing, raising, approving or charging the payroll sends anything as a signer who took no part. */
    expect(new Set(askedBy.slice(from))).toEqual(new Set(['ada', 'bo']));
  }, 170_000);
});

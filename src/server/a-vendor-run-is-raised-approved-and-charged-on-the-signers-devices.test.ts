/**
 * **A VENDOR RUN IS RAISED, APPROVED AND CHARGED ON THE SIGNERS' DEVICES, AS PAYROLL IS, AND ITS FILING NAMES NO
 * VENDOR.** Two vendors paid monthly - one added by address, paid at it with no payslip key, one invited by link and
 * admitted on their fingerprint - are drawn on a run over the vendor list on Ada's device and raised there, approved on
 * Bo's, and made ready to pay and charged to the vault's period on Bo's: the raise, the approval and the payout
 * material each check the vendors' terms from the run's own list. Nothing the service is sent or keeps names a vendor
 * by id, address or name. A vendor's terms changed under a raised run make that run refused at the approval; it is
 * withdrawn, drawn again as a repeat of it, and raised and approved at the new terms.
 *
 * Over real HTTP, with the vendors added, accepted and admitted on devices. The chain is the test's stand-in: it counts
 * approvals by who sent them, takes a charge without counting them, and runs none of the contract's circuits.
 */
import { describe, it, expect } from 'vitest';
import { identityFromSecret } from 'midnight-identity';
import { signJoinCode } from 'midnight-identity/profile/join-code';
import { newProposalId } from '../core/proposal-filing.js';
import { TEST_SETTLEMENT_ASSET } from '../core/assets.js';
import { canonical, randomBytes, signingPublicKeyOf, toHex, type Hex } from '../core/crypto.js';
import { openSealedRun } from '../core/run-legs.js';
import type { RoundOnThePage } from 'vaults-web-shared/governed-call-on-device.js';
import { buildRetryRun, buildRun, rootOfPayments } from '../midnight/payout-tree.js';
import { theNetwork } from '../midnight/network.js';
import type { RecordsAsked } from '../midnight/records-held.js';
import { payeeFor } from '../testing/payees.js';
import { aVaultHolding } from '../testing/assets.js';
import { vaultDetails } from '../testing/vault-details.js';
import { anchoredOver } from '../testing/record-tree-double.js';
import { periodsPastDraftHere, type CompanyRecordsHere } from 'vaults-web-shared/run-rebuilt-here.js';
import { approveOnDevice, governedCallServiceFor, raiseRunOnDevice, withdrawOnDevice } from 'vaults-web-shared/governed-call-on-device.js';
import type { LegRaiseDoors } from 'vaults-web-shared/run-raised-here.js';
import { drawRunHere } from 'vaults-web-shared/run-drawn-here.js';
import { legToPayHere } from 'vaults-web-shared/payments-made-here.js';
import { legPaymentsHere } from 'vaults-web-shared/material-made-here.js';
import { chargeTheRunHere, type ChargeInFlight } from 'vaults-web-shared/run-charged-here.js';
import { inFlightInMemory, sealedOnThisDevice } from 'vaults-web-shared/in-flight-on-this-device.js';
import { checkedHeadsInMemory } from 'vaults-web-shared/tree-kept-here.js';
import { directoryHere } from 'vaults-web-shared/vault-page-doors.js';
import { anchorTheRecordsHere } from 'vaults-web-shared/records-anchored-here.js';
import { acceptAsPayeeHere, inviteHere, openInvitationHere } from 'vaults-web-shared/invitation-on-device.js';
import { readPeopleHere, type PeopleDevice } from 'vaults-web-shared/people-on-device.js';
import { admitVendorHere, changeVendorHere, readVendorsHere } from 'vaults-web-shared/vendors-on-device.js';
import { ACME, acmeDirectory, acmeDirectoryDeps, fromAda, ORIGIN, wire } from './a-company-of-two-seats.test-support.js';
import {
  aCompanyWhoseSignersChange, acmeChain, ADA, ADDRESS, BO, anchorDoorsOf, aPolicyFiledBy, api, apiAs, attestedByTheRoster, chargedOnChain, CO, CY,
  deviceOf, KEY, LABEL, oneOffRecordsOf, recordsSecretOf, sendAs, store, VAULT, type Seat,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';

const { pureCircuits } = await import('../../contracts/managed/contract/index.js');

aCompanyWhoseSignersChange();

const NOW = BigInt(Math.floor(Date.now() / 1000));
const NETWORK = theNetwork();
const addressOf = (n: number) => payeeFor(n.toString(16).padStart(2, '0').repeat(32), NETWORK).bech32;
const MONTHLY = { kind: 'monthly' as const, asset: TEST_SETTLEMENT_ASSET, amount: 90000n };
const peopleOn = (s: Seat): PeopleDevice => ({
  company: ACME, signingSecret: s.signingSecret, signedInAs: s.person, send: sendAs(s.person), directory: acmeDirectory, network: NETWORK,
  entered: s.entered,
});
/** A vendor paid monthly, added by `address` (paid at it at once, no payslip key) or invited by link and admitted on their fingerprint. */
const aVendor = async (n: number, how: 'address' | 'link'): Promise<string> => {
  const made = await inviteHere(ACME, ADA, 'vendor', {
    name: `Vendor ${n}`, email: `vendor${n}@vendors.co`, startDate: '2026-10-01', terms: MONTHLY, network: NETWORK,
    ...(how === 'address' ? { address: addressOf(n) } : {}),
  }, ORIGIN, fromAda, { vendors: () => readVendorsHere(peopleOn(ADA)) });
  if (how === 'link') {
    const code = signJoinCode(identityFromSecret(new Uint8Array(32).fill(n)), LABEL, made.person!, { kind: 'payee', address: addressOf(n), payslipKey: 'cd'.repeat(32) });
    const { fingerprint } = await acceptAsPayeeHere(await openInvitationHere(made.link, sendAs(null)), code, sendAs(`usr_v${n}`));
    const read = await readVendorsHere(peopleOn(ADA));
    await admitVendorHere(peopleOn(ADA), [...read.vendors, ...read.notPayable.map((x) => x.here)].find((v) => v.vendor.id === made.person)!, fingerprint);
  }
  return made.person!;
};
const checkedBy = new Map<string, ReturnType<typeof checkedHeadsInMemory>>();
/** `s`'s device's whole company records: its directory, its people, its vendors and runs, and the one-offs and payments it reads. */
const recordsOf = (s: Seat): CompanyRecordsHere & { readonly proposals: () => Promise<ReturnType<typeof store.listProposals>> } => {
  const checked = checkedBy.get(s.seat) ?? checkedBy.set(s.seat, checkedHeadsInMemory()).get(s.seat)!;
  const directory = (asked?: RecordsAsked) => directoryHere({
    ...acmeDirectoryDeps(), attested: attestedByTheRoster(s), anchored: anchoredOver(apiAs(s.person), CO, acmeChain.read, undefined, undefined, checked),
  }, asked);
  return {
    ...oneOffRecordsOf(s),
    directory,
    people: () => readPeopleHere(peopleOn(s)), vendors: () => readVendorsHere(peopleOn(s)),
    runs: async () => store.listRuns(CO),
    proposals: async () => store.listProposals(CO),
    checked: async () => { await directory(); return checked.read(CO); },
    roundIdentity: pureCircuits as never,
    policy: async () => ({ threshold: 1, limitsByRole: {} }) as never,
  };
};
const drawingOn = (s: Seat) => ({
  api: api(s.person), accountId: CO, viewingKey: KEY, keyEpoch: 0, signingSecret: s.signingSecret as Hex, company: { account: ADDRESS, label: LABEL },
  records: recordsOf(s) as never, by: s.person, entered: s.entered,
});
const raisingOn = (s: Seat): LegRaiseDoors => {
  const device = deviceOf(s);
  return {
    service: device.service, builder: device.builder as never, material: device.material as never, accountId: CO,
    records: recordsOf(s), holdings: aVaultHolding(),
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
/** The vault's policy for the settlement currency: one period holding every window here, and two approvals a run. */
const TWO_APPROVALS = {
  bands: [
    { ceiling: '1000000000', approvals: '2' }, { ceiling: '2000000000', approvals: '2' }, { ceiling: '3000000000', approvals: '2' }, { ceiling: '4000000000', approvals: '2' },
  ],
  periodLimit: '100000000000', periodStart: String(NOW - 3_600n), periodLength: '864000',
};
const raiseOn = (s: Seat, runId: string) => raiseRunOnDevice(raisingOn(s), { runId, viewingKey: KEY, vault: VAULT, opensAt: String(NOW + 3_600n), closesAt: String(NOW + 7_200n) });

let byAddress: string;
let byLink: string;

describe('A VENDOR RUN IS RAISED, APPROVED AND CHARGED THROUGH THE SIGNERS\' OWN DOORS', () => {
  it('drawn on Ada\'s device, raised there, approved on Bo\'s and charged there, paying each vendor their terms, the one added by address with no payslip', async () => {
    await aPolicyFiledBy(ADA, [ADA, BO, CY], { terms: TWO_APPROVALS, asset: TEST_SETTLEMENT_ASSET });
    byAddress = await aVendor(85, 'address');
    byLink = await aVendor(86, 'link');
    const from = wire.length;
    const run = await drawRunHere(drawingOn(ADA), { period: '2031-03', list: 'vendors' });
    expect(run.employees.map((e) => e.id).sort()).toEqual([byAddress, byLink].sort());
    /* RED WHEN: the payments a vendor run's leg would make are worked out from the employees, before it is raised. */
    expect((await legPaymentsHere(recordsOf(ADA), CO, run.id, KEY)).payments).toHaveLength(2);
    /* RED WHEN: the raise checks a vendor run against the employees, where its vendors are nobody. */
    const round = await raiseOn(ADA, run.id);
    expect(round.approvalCount).toBe(1);
    const bos = recordsOf(BO);
    /* RED WHEN: the approval checks a vendor run against the employees, or does not read its vendors' terms. */
    const approved = await approveOnDevice({ ...deviceOf(BO), records: bos }, { round, viewingKey: KEY });
    expect(approved.approvalCount).toBe(2);
    /* RED WHEN: the payout material is made for a vendor run from the employees, or a vendor with no payslip key stops it. */
    const toPay = await legToPayHere(bos, CO, run.id, KEY, PAYING);
    expect(toPay.order.payments.map((p) => p.amount)).toEqual(['90000', '90000']);
    expect((await chargeTheRunHere(chargingOn(BO, bos), toPay)).state).toBe('charged');
    /* RED WHEN: a vendor run's filing, raise, approval or charge sends or keeps a vendor's id, address or name where the service reads it. */
    /* A device reads a vendor's entry by its record's name, as every record is read; the run's filing and its proposal's name none. */
    const sent = wire.slice(from).filter((w) => / \/api\/(accounts\/[^/ ]+\/runs|proposals\/|accounts\/[^/ ]+\/proposals)/u.test(w)).join('\n');
    const kept = canonical({ run: store.getRun(run.id), proposals: store.listProposals(CO) });
    for (const said of [byAddress, byLink, addressOf(85), addressOf(86), addressOf(85).slice(-24), addressOf(86).slice(-24), 'Vendor 85', 'Vendor 86', 'vendor85@vendors.co']) {
      expect(sent, said).not.toContain(said);
      expect(kept, said).not.toContain(said);
    }
    expect(openSealedRun(store.getRun(run.id)!, KEY).list).toBe('vendors');
  }, 170_000);

  it('RED WHEN: a raised vendor run is approved after the vendor\'s terms changed; withdrawn and drawn again as its repeat, it is raised and approved at the new terms', async () => {
    /* March's run is still open on the test's chain, so the vendor whose terms change is on April's run only. */
    const changing = await aVendor(87, 'address');
    const PAID_IN_MARCH_ONLY = { employeeIds: [byAddress, byLink], reason: 'Paid on the March run, still open' };
    const run = await drawRunHere(drawingOn(ADA), { period: '2031-04', list: 'vendors', employeeIds: [changing], skipPending: PAID_IN_MARCH_ONLY });
    const round: RoundOnThePage = await raiseOn(ADA, run.id);
    const pastDraft = () => periodsPastDraftHere(recordsOf(ADA) as never, CO, KEY, new Date(), 'vendors');
    const read = await readVendorsHere(peopleOn(ADA));
    await changeVendorHere(peopleOn(ADA), read.vendors.find((v) => v.vendor.id === changing)!, { terms: { ...MONTHLY, amount: 95000n } }, pastDraft);
    await expect(approveOnDevice({ ...deviceOf(BO), records: recordsOf(BO) }, { round, viewingKey: KEY })).rejects.toThrow(/their terms are 95000 a month/u);
    await withdrawOnDevice({ ...deviceOf(ADA), records: recordsOf(ADA) }, { round, viewingKey: KEY });
    const again = await drawRunHere(drawingOn(ADA), { period: '2031-04', list: 'vendors', employeeIds: [changing], skipPending: PAID_IN_MARCH_ONLY, repeats: { runIds: [run.id], reason: 'Vendor 87\'s terms changed' } });
    expect(again.employees.find((e) => e.id === changing)?.amount).toBe(95000n);
    const second = await raiseOn(ADA, again.id);
    expect((await approveOnDevice({ ...deviceOf(BO), records: recordsOf(BO) }, { round: second, viewingKey: KEY })).approvalCount).toBe(2);
  }, 170_000);
});

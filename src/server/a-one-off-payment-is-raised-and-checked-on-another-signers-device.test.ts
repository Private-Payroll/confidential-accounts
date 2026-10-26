import { describe, it, expect, beforeEach } from 'vitest';
import { newSymmetricKey, type Hex } from '../core/crypto.js';
import { sealingWith } from '../core/company-key.js';
import { batchDigestOf, newProposalId, sealTransferProposal, signProposalFiling } from '../core/proposal-filing.js';
import { DEVICE_RAISE_VERSION } from '../core/device-raise.js';
import type { PayrollRun } from '../core/types.js';
import { newOneOffId, newOneOffSeed, type OneOffGiven } from '../midnight/one-off-record.js';
import { buildOneOffRun, paidMovementOfLeaf, paidOnceOfNonce } from '../midnight/payout-tree.js';
import { oneOffSecretsOf } from '../midnight/run-keys.js';
import { NO_LEG } from '../midnight/spending-policy-record.js';
import { proposalEntry } from '../midnight/record-manifest.js';
import { payeeFor } from '../testing/payees.js';
import { registryWithTestPrivateForms, TEST_TOKEN } from '../testing/assets.js';
import { vaultDetails } from '../testing/vault-details.js';
import { openTheRoundHere } from 'vaults-web-shared/round-opened-here.js';
import { refuseWhatThisDeviceDidNotMake } from 'vaults-web-shared/what-this-device-made.js';
import { oneOffsHere } from 'vaults-web-shared/one-off-here.js';
import { fileOneOffHere, oneOffToPayHere, raiseOneOffHere, type OneOffAsked } from 'vaults-web-shared/one-off-raised-here.js';
import { checkedAgainstTheRecordsAndTheWallet } from 'vaults-web-shared/run-rebuilt-here.js';
import { RAISE_CHECKS } from 'vaults-web-shared/raise-checks-here.js';
import {
  aCompanyWhoseSignersChange, ADA, BO, CO, CY, deviceOf, directoryOf, KEY, ledgerViewNow, oneOffRaiseDoorsOf, oneOffRecordsOf,
  paidOnChain, VAULT,
} from './a-company-whose-signers-change-on-the-chain.test-support.js';
import { store } from './a-company-of-two-seats.test-support.js';

const { pureCircuits } = await import('../../contracts/managed/contract/index.js');

/**
 * A one-off payment from the company's vault, raised on one signer's device through the service's own routes, and
 * checked on another signer's device before it would approve it: made again there from the record the proposal names,
 * so a proposal whose run pays anything other than what its record says is refused. And what payroll's own checks read
 * once a one-off has been paid: its entries on the account are the company's records', not unexplained.
 */

aCompanyWhoseSignersChange();

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const bytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const REGISTRY = registryWithTestPrivateForms();
const NOW = BigInt(Math.floor(Date.now() / 1000));
const NORTHWIND = payeeFor('a7'.repeat(32), 'undeployed').bech32;
const SOMEONE_ELSE = payeeFor('b8'.repeat(32), 'undeployed');
const asked = (o: Partial<OneOffAsked> = {}): OneOffAsked & { viewingKey: typeof KEY } => ({
  vault: VAULT, asset: TEST_TOKEN, amount: 31_415_926n, form: 'private',
  payee: { ref: null, name: 'Northwind Paper Ltd', address: NORTHWIND, network: 'undeployed' },
  reason: 'Invoice 2026-118, office paper', opensAt: NOW - 60n, closesAt: NOW + 86_400n, viewingKey: KEY, ...o,
});
/** The account's own check, on `who`'s device, of what a proposal pays before an approval is built. */
const checkedOn = async (who: typeof ADA, proposalId: string) => {
  const opened = await openTheRoundHere(deviceOf(who).service, CO, proposalId, KEY, false, oneOffRecordsOf(who));
  refuseWhatThisDeviceDidNotMake({
    runPayload: pureCircuits.runPayload, vaultDetails, retrySaltOf: pureCircuits.retrySaltOf, payKeyCommitmentOf: pureCircuits.payKeyCommitmentOf,
  }, opened, ledgerViewNow(), 'approve');
  return opened;
};

/** What CY's device would file and send if it raised a one-off whose record says one payment and whose run pays another. */
const aForgedOneOff = async (o: {
  readonly says: { amount: bigint }; readonly pays: { amount: bigint }; readonly namesProposal?: string;
  readonly saltOverALeg?: true; readonly recordVault?: string; readonly raisedBy?: typeof ADA;
}) => {
  const seed = newOneOffSeed();
  const secrets = oneOffSecretsOf(seed);
  const id = newProposalId();
  const window = { opensAt: NOW - 60n, closesAt: NOW + 86_400n };
  const tree = buildOneOffRun({ payee: SOMEONE_ELSE, token: TEST_TOKEN, amount: o.pays.amount }, secrets, vaultDetails, TEST_TOKEN);
  const salt = hex(pureCircuits.retrySaltOf(o.saltOverALeg === true ? bytes('9c'.repeat(32)) : NO_LEG(), bytes(secrets.fresh)));
  const digest = hex(pureCircuits.runPayload(bytes(tree.tree.root), 1n, window.opensAt, window.closesAt, 0n));
  const chainId = hex(pureCircuits.proposalIdOf(bytes(digest), bytes(VAULT), bytes(salt)));
  const doors = oneOffRaiseDoorsOf(CY);
  const oneOffId = newOneOffId();
  const given: OneOffGiven = {
    vault: (o.recordVault ?? VAULT) as Hex, asset: TEST_TOKEN, amount: o.says.amount, form: 'private',
    payee: { ref: null, name: 'Northwind Paper Ltd', address: NORTHWIND, network: 'undeployed' }, reason: 'Invoice 2026-119',
    proposal: { id: o.namesProposal ?? id, chainId: chainId as Hex }, run: { ...window, required: 0n }, seed,
  };
  await fileOneOffHere({
    accountId: CO, directory: directoryOf(CY), records: { at: doors.records.oneOffs.at, ...doors.oneOffFiling },
    keys: KEY, signingSecret: CY.signingSecret as Hex, entered: CY.entered, keyEpoch: 0, registry: REGISTRY,
  }, { id: oneOffId, given });
  const proposal = signProposalFiling(CO, {
    id, digest: digest as Hex, chainId: chainId as Hex, keyEpoch: 0, createdAt: new Date().toISOString(),
    sealed: sealTransferProposal({
      accountId: CO, viewingKey: sealingWith(KEY, 0).key, vault: VAULT as Hex, summary: 'One-off payment from a vault', oneOff: { id: oneOffId, version: 1 },
      change: { asset: TEST_TOKEN, amount: o.says.amount, batchDigest: batchDigestOf([]), salt: salt as Hex }, proposedBy: (o.raisedBy ?? CY).seat,
    }),
  }, (o.raisedBy ?? CY).signingSecret as Hex);
  const tx = Buffer.from(JSON.stringify({
    signer: (o.raisedBy ?? CY).seat, order: { circuit: 'propose', proposal: chainId, run: { root: tree.tree.root, payees: '1', opensAt: String(window.opensAt), closesAt: String(window.closesAt), vault: VAULT, required: '0' } },
  })).toString('base64');
  await oneOffRaiseDoorsOf(o.raisedBy ?? CY).service.file!(CO, { proposal, tx, version: DEVICE_RAISE_VERSION, salt, vault: VAULT });
  await (o.raisedBy ?? CY).entered.enter([proposalEntry(CO, proposal)]);
  return id;
};

beforeEach(() => { paidOnChain.clear(); });

describe('A ONE-OFF PAYMENT RAISED ON ONE SIGNER\'S DEVICE IS MADE AGAIN ON ANOTHER\'S BEFORE IT IS APPROVED', () => {
  it('RAISED BY CY, IT IS SENT WITH ITS VAULT AND NOTHING OF WHAT IT PAYS, AND ADA\'S DEVICE REBUILDS THE RUN THE CHAIN HOLDS FROM ITS RECORD', async () => {
    const doors = oneOffRaiseDoorsOf(CY);
    const sent: string[] = [];
    const watched = { ...doors, service: { ...doors.service, file: async (a: string, b: never) => { sent.push(JSON.stringify(b)); return doors.service.file!(a, b); } } };
    const round = await raiseOneOffHere(watched as never, asked());
    expect(round.status).toBe('open');
    expect(round.recordsAnchored, String(round.recordsAnchored)).toBe(true);
    /* RED WHEN: the raise sends the service what it pays, to whom or why, or a payments list or run beside the proposal. */
    expect(sent.length).toBe(1);
    const body = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['proposal', 'salt', 'tx', 'vault', 'version']);
    for (const plain of ['31415926', 'Northwind', NORTHWIND, 'Invoice 2026-118']) expect(sent[0]!.includes(plain), plain).toBe(false);
    expect(store.getProposal(round.id)?.pays).toBeUndefined();

    /* RED WHEN: another signer's device cannot open the one-off a `transfer` proposal names, or rebuilds another run than the chain holds. */
    const opened = await checkedOn(ADA, round.id);
    expect(opened.made).toMatchObject({ kind: 'transfer', asset: TEST_TOKEN, required: '0' });
    expect((opened.made as { facts: { amount: bigint } }).facts.amount).toBe(31_415_926n);
    await expect(checkedOn(BO, round.id)).resolves.toBeDefined();
  }, 170_000);

  it('A ONE-OFF WHOSE RECORD SAYS ONE PAYMENT AND WHOSE RUN PAYS ANOTHER IS REFUSED ON ANOTHER SIGNER\'S DEVICE', async () => {
    const forged = await aForgedOneOff({ says: { amount: 100n }, pays: { amount: 100_000n } });
    /* RED WHEN: a device approves a one-off by its record's words, not by the run its proposal names on the chain. */
    await expect(checkedOn(ADA, forged)).rejects.toThrow(/What this proposal pays is not what this device rebuilt/u);
  }, 170_000);

  it('A ONE-OFF WHOSE RECORD NAMES ANOTHER PROPOSAL, OR THAT IS ALREADY PAID, IS REFUSED', async () => {
    const elsewhere = await aForgedOneOff({ says: { amount: 100n }, pays: { amount: 100n }, namesProposal: newProposalId() });
    /* RED WHEN: a record raised over another proposal is taken as this one's. */
    await expect(checkedOn(ADA, elsewhere)).rejects.toThrow(/says it is raised by another proposal/u);
    /* RED WHEN: a one-off is approved for another vault than its record pays from. */
    await expect(checkedOn(ADA, await aForgedOneOff({ says: { amount: 9n }, pays: { amount: 9n }, recordVault: 'fb'.repeat(32) })))
      .rejects.toThrow(/paid from another vault/u);
    /* RED WHEN: a one-off whose record one seat filed is raised by another seat and approved. */
    await expect(checkedOn(ADA, await aForgedOneOff({ says: { amount: 9n }, pays: { amount: 9n }, raisedBy: BO })))
      .rejects.toThrow(/filed by another seat than the one that raised it/u);
    /* RED WHEN: a one-off raised with a retry's salt is approved, though the chain would charge it nothing as a retry of a leg. */
    await expect(checkedOn(ADA, await aForgedOneOff({ says: { amount: 9n }, pays: { amount: 9n }, saltOverALeg: true })))
      .rejects.toThrow(/salt was not made from its one-off payment's record/u);

    const round = await raiseOneOffHere(oneOffRaiseDoorsOf(CY), asked({ amount: 7n }));
    const opened = await checkedOn(ADA, round.id);
    const nonce = oneOffSecretsOf((opened.made as { seed: string }).seed).nonce;
    paidOnChain.add(paidOnceOfNonce(nonce).toLowerCase());
    /* RED WHEN: a one-off the account already records as paid is approved again, to be refused when paid. */
    await expect(checkedOn(ADA, round.id)).rejects.toThrow(/already recorded as paid/u);
  }, 170_000);

  it('A PAID ONE-OFF IS ONE OF THE COMPANY\'S RECORDS TO PAYROLL\'S CHECK OF THE CHAIN, AND IS OFFERED TO PAY AS ITS SIGNERS APPROVED IT', async () => {
    const round = await raiseOneOffHere(oneOffRaiseDoorsOf(CY), asked({ amount: 55n }));
    const records = oneOffRecordsOf(ADA);
    const mine = (await oneOffsHere(records, CO)).believed.find((o) => o.oneOff.proposal.id === round.id)!;
    expect(mine).toBeDefined();
    const pay = await oneOffToPayHere(records, CO, KEY, round.id, {
      runPayload: pureCircuits.runPayload, proposalIdOf: pureCircuits.proposalIdOf, retrySaltOf: pureCircuits.retrySaltOf,
      paidAmong: async () => ({ known: true, paid: [] }),
    });
    /* RED WHEN: the vault is handed another payment than the one-off's signers approved: another proposal, salt, leaf or amount. */
    expect(pay.proposalId).toBe(round.id);
    expect(pay.order.proposal).toBe(round.chainId);
    expect(pay.order.payments.map((p) => [p.amount, p.nonce, p.leaf])).toEqual([['55', mine.secrets.nonce, mine.tree.tree.leaves[0]]]);

    /* The one-off is paid: the account records its once-mark and its leaf's movement. */
    for (const o of (await oneOffsHere(records, CO)).believed) {
      paidOnChain.add(paidOnceOfNonce(o.secrets.nonce).toLowerCase());
      paidOnChain.add(paidMovementOfLeaf(o.tree.tree.leaves[0]!).toLowerCase());
    }
    const made = await checkedAgainstTheRecordsAndTheWallet(records, CO, { period: '2026-10' } as PayrollRun, KEY, {
      kind: 'payroll', seeds: [], payKey: '00'.repeat(32), identity: { accountId: CO, runId: 'run_x', epoch: 0 }, facts: [], records: [], asset: TEST_TOKEN,
      opensAt: '0', closesAt: '1', required: '0',
    });
    const unaccounted = RAISE_CHECKS.find((c) => c.name === 'unaccounted')!;
    /* RED WHEN: a paid one-off's entries on the account are not counted beside payroll's, so the next payroll raise is refused as unexplained. */
    expect(() => unaccounted.check({ made } as never, { circuits: records.payments } as never)).not.toThrow();
    expect(made.raising?.oneOffs?.nonces).toContain(mine.secrets.nonce);
  }, 170_000);

  it('THE ONE-OFF\'S RECORD IS SEALED WITH THE KEYS ITS PROPOSAL IS SEALED WITH, WHATEVER KEYS THE DEVICE READS ONE-OFFS WITH', async () => {
    const doors = oneOffRaiseDoorsOf(CY);
    /* The raising device's door for reading one-offs holds another key than the one the raise is given. */
    const stray = { ...doors, records: { ...doors.records, oneOffs: { ...doors.records.oneOffs, keys: newSymmetricKey() } } };
    const round = await raiseOneOffHere(stray, asked({ amount: 9n }));
    /* RED WHEN: the record and its proposal take their key from two doors, so a record no other device opens is filed beside a proposal they do. */
    const read = await oneOffsHere(oneOffRecordsOf(ADA), CO);
    expect(read.believed.some((o) => o.oneOff.proposal.id === round.id)).toBe(true);
    expect(read.unread).toEqual([]);
  }, 170_000);
});

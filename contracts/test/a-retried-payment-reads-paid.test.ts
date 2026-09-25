/**
 * **A PERSON THE FIRST ROUND MISSED AND A RETRY PAID READS "PAID" ON THEIR OWN
 * PAYSLIPS PAGE.**
 *
 * The account records a completed payment against a payee's leaf, and a retry
 * pays a person under the leaf they already had. So the receipt sealed to each
 * payee when the leg is raised answers for every attempt at that leg. This file
 * holds that against the compiled account contract: the leg pays one person,
 * its window closes, a retry pays another, and each payee's page - opening its
 * own receipt and reading the account's completed payments off the contract's
 * own state, through the same code its worker runs - says what happened to
 * them and only them.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountSimulator, privateStateFor } from './simulator.js';
import { AccountService } from '../../src/core/account.js';
import { PayrollService } from '../../src/core/payroll.js';
import { SimulatedLedger, SimulatedProofSystem, type StateChange } from '../../src/core/ledger.js';
import { MidnightCommitments } from '../../src/midnight/commitments.js';
import { buildRun, buildRetryRun } from '../../src/midnight/payout-tree.js';
import { runMaterialFor, retryMaterialFor } from '../../src/midnight/run-material.js';
import { paidMovementsIn, UndecodedLedgerField } from '../../src/midnight/ledger.js';
import { vaultDetails } from '../../src/testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../../src/testing/assets.js';
import { FileStore } from '../../src/core/store-file.js';
import { assetIdBytes } from '../../src/core/assets.js';
import { openPayslip } from '../../src/core/payslip-open.js';
import { paymentsOnTheChain } from '../../src/web/my-payslips.js';
import { answerPayslipAsk, type PayslipReaderDeps } from '../../src/web/payslip-worker-entry.js';
import type { ChainReader } from '../../src/web/payslip-worker-client.js';
import { ledger as readLedger } from '../managed/contract/index.js';
import { fromHex, toHex, unseal, parseCanonical, type Hex, type Sealed } from '../../src/core/crypto.js';

const PAYROLL_VAULT = new Uint8Array(32).fill(0xa1);
const NOW = 1_800_000_000;
const OPENS = BigInt(NOW - 3_600);
const CLOSES = BigInt(NOW + 3_600);
const RETRY_OPENS = BigInt(NOW - 60);
const RETRY_CLOSES = BigInt(NOW + 86_400);

afterEach(() => { vi.useRealTimers(); });

const changeOf = (sealedPayload: Sealed, viewingKey: Hex): StateChange =>
  parseCanonical<{ __change: StateChange }>(unseal(sealedPayload, viewingKey)).__change;

const deviceCarrying = (
  secrets: { signingSecret: Hex; blinding: Hex; scope: Hex }, change: StateChange,
) => ({
  ...privateStateFor(9),
  secretKey: fromHex(secrets.signingSecret),
  blinding: fromHex(secrets.blinding),
  scope: fromHex(secrets.scope),
  assetId: assetIdBytes(change.asset),
  changeAmount: change.amount,
  changeBatchDigest: fromHex(change.batchDigest),
  proposalSalt: fromHex(change.salt),
});

describe('a payment made by a retry reads as paid on its payee\'s page', () => {
  it('PAID FOR WHOEVER EITHER ATTEMPT PAID, NOT YET FOR WHOEVER NEITHER DID', async () => {
    const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-retry-paid-')), 'db.json'));
    const registry = registryWithTestPrivateForms();
    const ledger = new SimulatedLedger(MidnightCommitments);
    /* A double, named: the retry door asks who was paid, and here the answer is nobody yet. */
    Object.assign(ledger, { paidAmong: async () => ({ known: true, paid: [] }) });
    const accounts = new AccountService(store, ledger, MidnightCommitments, registry, aVaultHolding());
    const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);

    const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
    const viewingKey = created.viewingKey;
    const rec = accounts.require(created.account.id);
    store.putAccount({ ...rec, addressSource: 'chain' } as typeof rec);
    const company = (rec.contractAddress as string).toLowerCase();
    const people = [0, 1, 2].map(i => payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey));
    const { run } = await payroll.createRunFromRoster(created.account.id, '2026-08', viewingKey);
    const inputs = await payroll.runMaterialInputs(run.id, viewingKey);
    const material = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
      opensAt: OPENS, closesAt: CLOSES, vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
    });
    const by = created.secrets[0]!.signerId;
    const proposal = await payroll.proposeRun(run.id, viewingKey, by, material);
    const legChange = changeOf(proposal.sealedPayload, viewingKey);

    /* The chain opens and approves the leg the product raised, and the leg pays person 0. */
    const sim = await AccountSimulator.create(privateStateFor(9));
    await sim.seatLeaf(fromHex(created.account.signers[0]!.leafCommitment!), [privateStateFor(9)], 61);
    sim.at(NOW);
    const legDevice = deviceCarrying(created.secrets[0]!, legChange);
    await sim.as(legDevice).proposeRun({
      root: fromHex(material.run.root), payees: material.run.payees,
      from: OPENS, until: CLOSES, vault: PAYROLL_VAULT,
    });
    const legId = fromHex(proposal.chainId);
    await sim.as(legDevice).approve(legId);
    const rebuild = (await payroll.payoutRebuildOf(run.id, viewingKey))!;
    const whole = buildRun(rebuild.seeds, rebuild.identity, rebuild.facts, vaultDetails);
    const first = whole.payeeArgs(0);
    await sim.as(legDevice).recordPayment({
      proposal: legId, vault: PAYROLL_VAULT, root: fromHex(material.run.root),
      payees: material.run.payees, from: OPENS, until: CLOSES,
      salt: fromHex(legChange.salt), details: fromHex(first.details),
      nonce: fromHex(first.nonce), path: first.path,
    });

    /* The leg's window closes with persons 1 and 2 unpaid; a retry over person 1 pays them. */
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((Number(CLOSES) + 60) * 1000);
    const retry = await retryMaterialFor({
      rebuild, indices: [1], opensAt: RETRY_OPENS, closesAt: RETRY_CLOSES,
      vault: toHex(PAYROLL_VAULT), detailsOf: vaultDetails,
    });
    const raised = await payroll.proposeRetry(run.id, viewingKey, by, retry);
    const retryChange = changeOf(raised.sealedPayload, viewingKey);
    const retryDevice = deviceCarrying(created.secrets[0]!, retryChange);
    await sim.as(retryDevice).proposeRun({
      root: fromHex(retry.run.root), payees: retry.run.payees,
      from: RETRY_OPENS, until: RETRY_CLOSES, vault: PAYROLL_VAULT,
    });
    const retryId = fromHex(raised.chainId);
    await sim.as(retryDevice).approve(retryId);
    const smaller = buildRetryRun(whole, [1]);
    const onlyOne = smaller.payeeArgs(0);
    await sim.as(retryDevice).recordPayment({
      proposal: retryId, vault: PAYROLL_VAULT, root: fromHex(retry.run.root),
      payees: retry.run.payees, from: RETRY_OPENS, until: RETRY_CLOSES,
      salt: fromHex(retryChange.salt), details: fromHex(onlyOne.details),
      nonce: fromHex(onlyOne.nonce), path: onlyOne.path,
    });

    /* The account's completed payments, read off the contract's own state, relayed whole. */
    const onChain = paidMovementsIn(sim.ledger);
    expect(onChain).toHaveLength(2);
    /* The contract state as an indexer hands it back: a `ContractState` whose `data` is the ledger. */
    const state = sim.contractStateForCall;
    /*
     * **THE DEVICE'S OWN READ, AS ITS WORKER DOES IT**: the indexer is asked for
     * the contract at the receipt's company address and answers the state
     * above, and the contract's own decoder reads the set. Only the indexer
     * reader itself is a stand-in, and it records every address it is asked.
     */
    const INDEXER = { indexerUri: 'https://indexer.example/graphql', indexerWsUri: 'wss://indexer.example/graphql/ws' };
    const asked: string[] = [];
    const deps: PayslipReaderDeps = {
      sourceFor: async (indexer) => {
        expect(indexer).toEqual(INDEXER);
        return { queryContractState: async (address: string) => { asked.push(address); return address === company ? state : null; } };
      },
      readLedger: async () => readLedger as (data: unknown) => unknown,
    };
    let next = 0;
    const onThisDevice: ChainReader = {
      recorded: async (indexer, at, movements) =>
        (await answerPayslipAsk(deps, { id: (next += 1), indexer, company: at, movements })).recorded,
    };

    const answers = [] as string[];
    const late = [] as string[];
    for (const p of people) {
      const [sealed] = payroll.payslipsFor(
        (store.getEmployee(p.employee.id)!.wrappingPublicKey as string), company);
      const opened = openPayslip(sealed!, p.secret.wrappingSecret);
      expect(opened.receipt).not.toBeNull();
      answers.push((await paymentsOnTheChain([opened], onThisDevice, INDEXER, NOW)).get(run.id)!);
      late.push((await paymentsOnTheChain([opened], onThisDevice, INDEXER, Number(CLOSES) + 60)).get(run.id)!);
    }
    /*
     * RED WHEN the receipt sealed to a payee is not their own leaf's - a
     * receipt built off the wrong position reads person 1, whom the retry paid,
     * or person 0, whom the leg paid, as not yet, and person 2, whom nobody
     * paid, as paid. The answer is not the same read backwards, so a mapping
     * that runs the wrong way round is caught too.
     */
    expect(answers).toEqual(['paid', 'paid', 'not-yet']);
    /*
     * Once the leg's window has closed, nothing written down can pay person 2
     * any more, so they are not told "not yet". RED WHEN a receipt does not
     * carry its window's end, or a retry does not write every receipt again.
     */
    expect(late).toEqual(['paid', 'paid', 'cannot-tell']);
    const person1 = openPayslip(payroll.payslipsFor(
      store.getEmployee(people[1]!.employee.id)!.wrappingPublicKey as string, company)[0]!, people[1]!.secret.wrappingSecret);
    const person2 = openPayslip(payroll.payslipsFor(
      store.getEmployee(people[2]!.employee.id)!.wrappingPublicKey as string, company)[0]!, people[2]!.secret.wrappingSecret);
    /* RED WHEN a retry does not extend the window of the people it names, and only theirs. */
    expect(person1.receipt!.until).toBe(Number(RETRY_CLOSES));
    expect(person2.receipt!.until).toBe(Number(CLOSES));
    /* Read by the company's address and nothing else. */
    expect(new Set(asked)).toEqual(new Set([company]));
  });

  it('THE DEVICE\'S READ ANSWERS "CANNOT SAY" FOR A CONTRACT IT COULD NOT READ, NEVER "NOT RECORDED"', async () => {
    const INDEXER = { indexerUri: 'https://indexer.example/graphql', indexerWsUri: 'wss://indexer.example/graphql/ws' };
    const ask = { id: 1, indexer: INDEXER, company: 'ab'.repeat(32), movements: ['cd'.repeat(32)] };
    const reading = (state: unknown, decode: (data: unknown) => unknown = readLedger as never): PayslipReaderDeps => ({
      sourceFor: async () => ({ queryContractState: async () => state }),
      readLedger: async () => decode,
    });
    /* RED WHEN no state, a state that does not decode, or a missing set is read as nothing recorded. */
    expect((await answerPayslipAsk(reading(null), ask)).recorded).toBeNull();
    expect((await answerPayslipAsk(reading({ data: {} }, () => { throw new Error('bad'); }), ask)).recorded).toBeNull();
    expect((await answerPayslipAsk(reading({ data: {} }, () => ({})), ask)).recorded).toBeNull();
    expect((await answerPayslipAsk({
      sourceFor: async () => { throw new Error('the indexer is down'); }, readLedger: async () => readLedger as never,
    }, ask)).recorded).toBeNull();
    /* And a set that is there answers per value. */
    const set = { movements: { member: (v: Uint8Array) => toHex(v) === 'cd'.repeat(32) } };
    expect((await answerPayslipAsk(reading({ data: {} }, () => set), ask)).recorded).toEqual([true]);
    expect((await answerPayslipAsk(reading({ data: {} }, () => set), { ...ask, movements: ['ef'.repeat(32)] })).recorded)
      .toEqual([false]);
  });

  it('A PAYMENT SET THAT DID NOT DECODE REFUSES, RATHER THAN READING AS NOBODY PAID', () => {
    /* RED WHEN a missing set is repaired into an empty one. */
    expect(() => paidMovementsIn({})).toThrow(UndecodedLedgerField);
    expect(() => paidMovementsIn({ movements: 7 })).toThrow(UndecodedLedgerField);
    expect(paidMovementsIn({ movements: [new Uint8Array(32).fill(0xab)] })).toEqual(['ab'.repeat(32)]);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../core/store-file.js';
import { SimulatedLedger, SimulatedProofSystem } from '../core/ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { AccountService } from '../core/account.js';
import { PayrollService, RecordingInviteDelivery } from '../core/payroll.js';
import { toHex } from '../core/crypto.js';
import { runMaterialFor } from '../midnight/run-material.js';
import { vaultDetails } from '../testing/vault-details.js';
import { payeeFor } from '../testing/payees.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import { sealHandover } from '../core/invite-handover.js';
import { payslipKeypairForWallet } from '../core/payslip-key.js';
import { newWords } from 'midnight-identity';
import type { User } from '../core/types.js';

/**
 * **THE RUN'S SALT IS THE ONE THING STANDING BETWEEN A PAYEE WHO HOLDS THEIR OWN
 * NONCE AND BLINDING AND RECORDING THEMSELVES PAID, AND NOTHING THAT DOES NOT
 * TAKE THE COMPANY'S VIEWING KEY HANDS IT OUT, OR A PAYEE'S PATH.**
 *
 * Two halves. The functions that produce a salt or a path refuse a wrong viewing
 * key. And every route in the service that reaches one of them is listed here
 * by name, and each of them takes the viewing key in its body: a new route that
 * reaches one is a red test until somebody has looked at it.
 */

const SERVER = join(__dirname);
/** Every file that declares a route, the fee payer's included. */
const FILES = ['index.ts', 'company-vaults.ts', 'vault-records-route.ts', 'vault-artefacts.ts', '../fee-payer/service.ts'];

/**
 * Every function in this service whose answer carries a run's salt or a payee's
 * merkle path, or what either can be rebuilt from: the payout seeds and the
 * run's identity (every nonce, blinding and so every leaf), and a leg's leaves
 * (every path).
 */
const HANDS_OUT = [
  'privatePaymentOrderOf', 'retryPaymentOrderOf', 'runSaltOf', 'assemblePrivatePayments',
  'raiseOrderOf', 'retryRaiseOrderOf', 'raiseOrderOnTheWire', 'raiseHalfOf', 'payeeArgs', 'pathFor', 'proposalSalt',
  'payoutRebuildOf', 'runMaterialInputs', 'payoutSeedsOf', 'payoutMaterialOf', '.leaves',
  /* A seat's or a threshold change's own salt, and the account's half of raising one. */
  'governanceOrderOf', 'governanceOrderOnTheWire', 'governanceAsked', 'roundForADevice', 'seatOrderOf', 'thresholdOrderOf',
];

/** Each route declaration in a file, with the text of its handler up to the next one. */
const routesIn = (file: string) => {
  const text = readFileSync(join(SERVER, file), 'utf8');
  const at = [...text.matchAll(/^\s*(?:app|router|r)\.(get|post|put|patch|delete)\(['`]([^'`]+)['`]/gmu)];
  return at.map((m, i) => ({
    file, route: `${m[1]!.toUpperCase()} ${m[2]}`,
    body: text.slice(m.index!, i + 1 < at.length ? at[i + 1]!.index : text.length),
  }));
};

describe('no route that does not take the viewing key returns a salt or a path', () => {
  it('EVERY ROUTE THAT REACHES A SALT OR A PATH IS ONE OF THESE, AND EACH TAKES THE VIEWING KEY', () => {
    const all = FILES.flatMap(routesIn);
    /* RED WHEN the walk stops finding routes: it would then pass by finding none. */
    expect(all.length).toBeGreaterThan(85);
    const reaching = all.filter(r => HANDS_OUT.some(f => r.body.includes(f)));
    /* RED WHEN a route is added that reaches one of them, or one of these stops doing so. */
    expect(reaching.map(r => r.route).sort()).toEqual([
      'POST /api/accounts/:id/signers/:signerId/round',
      'POST /api/accounts/:id/signers/:signerId/seat-order',
      'POST /api/accounts/:id/threshold/order',
      'POST /api/accounts/:id/threshold/round',
      'POST /api/proposals/:id/governance-send',
      'POST /api/runs/:id/payments',
      'POST /api/runs/:id/private-payments',
      'POST /api/runs/:id/propose',
      'POST /api/runs/:id/raise-order',
      'POST /api/runs/:id/raise-send',
      'POST /api/runs/:id/retry',
      'POST /api/runs/:id/retry-order',
      'POST /api/runs/:id/retry-send',
    ]);
    for (const r of reaching) {
      /* RED WHEN any of them reads its viewing key from anywhere but its own body, or not at all. */
      expect(r.body, r.route).toMatch(/viewingKey: z\.string\(\)/u);
      /* RED WHEN the key it reads is not the one it hands on. */
      expect(r.body, r.route).toMatch(/\bb(?:\.data)?\.viewingKey\b/u);
    }
  });

  it('THE SALT AND THE PAYMENT ORDER ARE REFUSED TO A WRONG VIEWING KEY', async () => {
    const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-salt-')), 'db.json'));
    const registry = registryWithTestPrivateForms();
    const accounts = new AccountService(
      store, new SimulatedLedger(MidnightCommitments), MidnightCommitments, registry, aVaultHolding());
    const invites = new RecordingInviteDelivery();
    const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry, 'undeployed', invites);
    const created = await accounts.create('Acme', [{ name: 'Ada', role: 'admin' as const }], 1);
    const rec = accounts.require(created.account.id);
    store.putAccount({ ...rec, addressSource: 'chain' } as typeof rec);
    const address = (rec.contractAddress as string).toLowerCase();
    const { sentTo, employee } = payroll.invite(created.account.id, {
      name: 'Dana', email: 'dana@acme.example', title: 'Engineer', asset: 'GBP', baseAmount: 100_00n,
    }, created.viewingKey, 'usr_ada');
    store.putUser({ id: 'usr_1', email: 'dana@acme.example', name: 'Dana', keyBundle: null, keyBundleVersion: 0,
      walletKey: null, createdAt: '2026-09-25T00:00:00.000Z' } as User);
    payroll.acceptInvite(invites.tokenFor(sentTo!), sealHandover({
      wrappingPublicKey: payslipKeypairForWallet(newWords(), address, 'https://payroll.example').publicKey,
      address: payeeFor('0d'.repeat(32), 'undeployed').bech32, confirmation: null, keyFrom: address,
    }, accounts.require(created.account.id).inboxPublicKey), 'usr_1');
    payroll.admit(employee.id, created.viewingKey, 'usr_ada');
    const { run } = await payroll.createRunFromRoster(created.account.id, '2026-08', created.viewingKey);
    const inputs = await payroll.runMaterialInputs(run.id, created.viewingKey);
    const material = await runMaterialFor({
      accountId: inputs.accountId, runId: inputs.runId, seeds: inputs.seeds, facts: inputs.facts,
      opensAt: 1_800_000_000n, closesAt: 1_800_086_400n, vault: toHex(new Uint8Array(32).fill(0xa1)), detailsOf: vaultDetails,
    });
    await payroll.proposeRun(run.id, created.viewingKey, created.secrets[0]!.signerId, material);
    const proposalId = payroll.requireRun(run.id, created.viewingKey).proposalIds.GBP!;
    const wrong = toHex(new Uint8Array(32).fill(0x55));
    /* The control: with the key, both answer. */
    expect(accounts.runSaltOf(proposalId, created.viewingKey)).toMatch(/^[0-9a-f]{64}$/u);
    expect(payroll.privatePaymentOrderOf(run.id, created.viewingKey)).not.toBeNull();
    /* RED WHEN either answers without the company's viewing key. */
    expect(() => accounts.runSaltOf(proposalId, wrong)).toThrow();
    expect(() => payroll.privatePaymentOrderOf(run.id, wrong)).toThrow();
  });
});

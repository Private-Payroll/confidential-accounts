/**
 * **A PAYROLL PROPOSAL WRITTEN DOWN HERE, BUILT ON A SIGNER'S DEVICE AND SENT
 * THROUGH THE LEDGER'S ONE DOOR FOR THAT - AND AN APPROVAL THE SAME WAY.**
 *
 * The chain here is the simulated ledger, and the door a device's transaction
 * goes through is a stand-in that records what it was handed and then does to
 * the simulated chain what the transaction would have done. What is pinned is
 * this service's half: what it writes down before anything is sent, what it
 * hands the device, when it refuses to send, what it records after, and that a
 * refusal before the send says nothing was sent.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService, approvalMessage } from './account.js';
import { PayrollService } from './payroll.js';
import { SimulatedLedger, SimulatedProofSystem, type StateChange } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { runMaterialFor } from '../midnight/run-material.js';
import { vaultDetails } from '../testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import { FileStore } from './store-file.js';
import { sign, toHex, type Hex } from './crypto.js';
import { assetIdBytes } from './assets.js';
import { saysNothingWasSent } from './jobs.js';

const VAULT = toHex(new Uint8Array(32).fill(0xa1));
const now = () => Math.floor(Date.now() / 1000);

type Send = (accountId: string, bytes: Uint8Array) => Promise<{ ref: string; at: string }>;

async function aCompany(opts: { door?: 'none' } = {}) {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-device-proposal-')), 'db.json'));
  const ledger = new SimulatedLedger(MidnightCommitments);
  const sent: Array<{ accountId: string; circuit: string; bytes: number[] }> = [];
  /** What the next transaction a device sends does to the chain, when the door takes it. */
  let effect: Send = async () => ({ ref: 'tx_unset', at: new Date().toISOString() });
  if (opts.door !== 'none') {
    Object.assign(ledger, {
      submitProvenCall: async (accountId: string, bytes: Uint8Array, circuit: string) => {
        sent.push({ accountId, circuit, bytes: [...bytes] });
        return effect(accountId, bytes);
      },
    });
  }
  const registry = registryWithTestPrivateForms();
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, aVaultHolding());
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  const created = await accounts.create('Northwind Ltd', [{ name: 'Ada', role: 'admin' }], 1);
  const viewingKey = created.viewingKey;
  for (let i = 0; i < 3; i++) {
    payroll.hireDirect(created.account.id, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
  }
  const account = created.account.id;
  const me = created.secrets[0]!;
  const window = { opensAt: BigInt(now() - 60), closesAt: BigInt(now() + 3_600) };
  const materialFor = async (runId: string) => {
    const i = await payroll.runMaterialInputs(runId, viewingKey);
    return runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts,
      opensAt: window.opensAt, closesAt: window.closesAt, vault: VAULT, detailsOf: vaultDetails,
      ...(i.epoch !== undefined ? { epoch: i.epoch } : {}),
    });
  };
  const drawn = await payroll.createRunFromRoster(account, '2026-08', viewingKey);
  const runId = drawn.run.id;
  const raiseOnDevice = async () =>
    payroll.proposeRun(runId, viewingKey, me.signerId, await materialFor(runId), undefined, { onDevice: true });
  /** This signer as the simulated chain knows them: by the leaf the roster holds. */
  const by = () => {
    const seat = accounts.open(account, viewingKey).signers.find((x) => x.id === me.signerId)!;
    return { signerId: me.signerId, leaf: seat.leafCommitment as Hex };
  };
  const openOnChain = async () => (await ledger.status(account))?.openProposals.map((p) => p.id) ?? [];
  /** What the device's raise does on the chain: the proposal, as the order describes it. */
  const theRaiseLands = (order: NonNullable<Awaited<ReturnType<typeof payroll.raiseOrderOf>>>): Send =>
    async (accountId) => {
      const change: StateChange = {
        asset: 'GBP', amount: BigInt(order.half.changeAmount), batchDigest: order.half.changeBatchDigest,
        salt: order.half.proposalSalt,
      };
      const r = await ledger.proposeRun(accountId, order.run, change, by());
      return { ref: `tx_${r.proposalId.slice(0, 8)}`, at: r.at };
    };
  const theApprovalLands = (chainId: Hex): Send => async (accountId) =>
    ledger.approve(accountId, chainId, by());
  return {
    accounts, payroll, ledger, viewingKey, account, me, runId, raiseOnDevice, openOnChain, sent,
    setEffect: (e: Send) => { effect = e; }, theRaiseLands, theApprovalLands,
  };
}

const BYTES = new Uint8Array([1, 2, 3, 4]);

describe('A PAYROLL PROPOSAL RAISED FROM A DEVICE', () => {
  it('IS WRITTEN DOWN AND NOTHING IS SENT FROM HERE: no chain call, no reference, not confirmed, and the leg points at it', async () => {
    const c = await aCompany();
    const round = await c.raiseOnDevice();
    /* RED WHEN: the device path still calls the ledger from this process - the chain then holds a proposal nobody's device built. */
    expect(await c.openOnChain()).toEqual([]);
    expect(c.sent).toEqual([]);
    /* RED WHEN: the proposal is marked sent or confirmed before any device sent it. */
    expect(round.txRef).toBeUndefined();
    expect(round.raisedAt).toBeUndefined();
    expect(round.status).toBe('open');
    /* RED WHEN: the leg is not pointed at the proposal - a second press then writes a second round over the same people. */
    expect(c.payroll.requireRun(c.runId, c.viewingKey).proposalIds.GBP).toBe(round.id);
    await expect(c.raiseOnDevice()).rejects.toThrow(/already proposed/u);
  });

  it('HANDS THE DEVICE THE RUN OFF THE LEG\'S RECORD AND THE ACCOUNT\'S HALF OFF THE PROPOSAL\'S OWN PAYLOAD, AND THEY MAKE THE PROPOSAL\'S ID', async () => {
    const c = await aCompany();
    const round = await c.raiseOnDevice();
    const order = (await c.payroll.raiseOrderOf(c.runId, c.viewingKey))!;
    const payout = c.payroll.requireRun(c.runId, c.viewingKey).payout!.GBP!;
    expect(order.proposalId).toBe(round.id);
    expect(order.chainId).toBe(round.chainId);
    expect(order.run).toEqual({
      root: payout.root, payees: payout.payees, opensAt: payout.opensAt, closesAt: payout.closesAt, vault: payout.vault,
    });
    /* RED WHEN: the salt handed over is not the one the proposal's id was made with - the device then raises a proposal nobody recorded. */
    expect(order.half.proposalSalt).toBe(c.accounts.runSaltOf(round.id, c.viewingKey));
    expect(MidnightCommitments.proposalId(
      MidnightCommitments.runPayload(order.run.root, order.run.payees, order.run.opensAt, order.run.closesAt),
      order.half.proposalSalt, order.run.vault)).toBe(round.chainId);
    /* RED WHEN: the change is not the leg's own - three people at one hundred pounds each - or names another asset. */
    expect(order.half.changeAmount).toBe('30000');
    expect(order.half.assetId).toBe(toHex(assetIdBytes('GBP')));
    /* RED WHEN: the account's half carries a blinding of the wrong width, or none. */
    expect(order.half.assetBlinding).toMatch(/^[0-9a-f]{64}$/u);
    expect(order.half.changeBatchDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('SENDS WHAT THE DEVICE BUILT THROUGH THE LEDGER\'S DOOR, AS THE ONE CALL IT IS, AND WRITES THE REFERENCE AND NOT A CONFIRMATION', async () => {
    const c = await aCompany();
    const round = await c.raiseOnDevice();
    const order = (await c.payroll.raiseOrderOf(c.runId, c.viewingKey))!;
    c.setEffect(c.theRaiseLands(order));
    const sent = await c.accounts.sendRaise(round.id, c.viewingKey, BYTES, c.me.signerId);
    /* RED WHEN: the bytes the device proved are not what the door is handed, or not as a raise. */
    expect(c.sent).toEqual([{ accountId: c.account, circuit: 'propose', bytes: [1, 2, 3, 4] }]);
    expect(sent.txRef).toMatch(/^tx_/u);
    /* RED WHEN: a send is written as a confirmation - the door answers before the chain holds anything. */
    expect(sent.raisedAt).toBeUndefined();
  });

  it('A SENT PROPOSAL IS SENT AGAIN ONLY WHEN THE CHAIN SAYS IT DOES NOT HOLD IT, AND NEVER ONCE IT DOES', async () => {
    const c = await aCompany();
    const round = await c.raiseOnDevice();
    const order = (await c.payroll.raiseOrderOf(c.runId, c.viewingKey))!;
    /* The first send is handed over and never arrives. */
    c.setEffect(async () => ({ ref: 'tx_dropped', at: new Date().toISOString() }));
    await c.accounts.sendRaise(round.id, c.viewingKey, BYTES, c.me.signerId);
    /* RED WHEN: a proposal the chain does not hold cannot be sent again - it is then stranded. */
    expect((await c.payroll.raiseOrderOf(c.runId, c.viewingKey))?.half.proposalSalt).toBe(order.half.proposalSalt);
    c.setEffect(c.theRaiseLands(order));
    await c.accounts.sendRaise(round.id, c.viewingKey, BYTES, c.me.signerId);
    expect(c.sent).toHaveLength(2);
    /* RED WHEN: a proposal the chain holds is sent again - a second copy, refused after its fee. */
    const again = await c.accounts.sendRaise(round.id, c.viewingKey, BYTES, c.me.signerId).catch((e) => e);
    expect(saysNothingWasSent(again)).toBe(true);
    expect(String(again.message)).toMatch(/already holds this proposal/u);
    expect(c.sent).toHaveLength(2);
    /* RED WHEN: a chain that cannot answer is taken as an answer. */
    const d = await aCompany();
    const other = await d.raiseOnDevice();
    d.setEffect(async () => ({ ref: 'tx_x', at: new Date().toISOString() }));
    await d.accounts.sendRaise(other.id, d.viewingKey, BYTES, d.me.signerId);
    const status = d.ledger.status.bind(d.ledger);
    Object.assign(d.ledger, { status: async () => null });
    const unknown = await d.accounts.sendRaise(other.id, d.viewingKey, BYTES, d.me.signerId).catch((e) => e);
    Object.assign(d.ledger, { status });
    expect(saysNothingWasSent(unknown)).toBe(true);
    expect(String(unknown.message)).toMatch(/did not answer whether it holds it/u);
    expect(d.sent).toHaveLength(1);
  });

  it('A SENT PROPOSAL THE CHAIN DOES NOT SHOW YET IS NOT WITHDRAWN HERE, BECAUSE IT MAY STILL ARRIVE', async () => {
    const c = await aCompany();
    const round = await c.raiseOnDevice();
    c.setEffect(async () => ({ ref: 'tx_on_its_way', at: new Date().toISOString() }));
    await c.accounts.sendRaise(round.id, c.viewingKey, BYTES, c.me.signerId);
    /* RED WHEN: it is closed locally - if it then lands, nothing here can ever withdraw it. */
    await expect(c.accounts.cancel(round.id, c.viewingKey)).rejects.toThrow(/may still arrive\. Nothing was withdrawn/u);
    expect(c.accounts.requireProposal(round.id, c.viewingKey).status).toBe('open');
    /* A proposal written down and never sent is withdrawn as before. */
    const d = await aCompany();
    const never = await d.raiseOnDevice();
    expect((await d.accounts.cancel(never.id, d.viewingKey)).status).toBe('cancelled');
  });

  it('ONLY A SIGNER WHO MAY PROPOSE SENDS ONE', async () => {
    const c = await aCompany();
    const round = await c.raiseOnDevice();
    for (const by of ['sgn_nobody']) {
      const refused = await c.accounts.sendRaise(round.id, c.viewingKey, BYTES, by).catch((e) => e);
      /* RED WHEN: the sender is not checked - any member then spends the company's fee on a transaction recorded as this proposal. */
      expect(saysNothingWasSent(refused)).toBe(true);
      expect(String(refused.message)).toMatch(/only a signer who may propose/u);
    }
    expect(c.sent).toEqual([]);
  });

  it('IS CONFIRMED WHEN THE CHAIN SHOWS IT, BY THE READ ANYBODY WITH THE VIEWING KEY MAY ASK, AND IS THEN NOT OFFERED TO BE SENT', async () => {
    const c = await aCompany();
    const round = await c.raiseOnDevice();
    const order = (await c.payroll.raiseOrderOf(c.runId, c.viewingKey))!;
    /* Before the chain holds it, the read changes nothing. */
    expect((await c.accounts.refreshStanding(round.id, c.viewingKey)).raisedAt).toBeUndefined();
    c.setEffect(c.theRaiseLands(order));
    await c.accounts.sendRaise(round.id, c.viewingKey, BYTES, c.me.signerId);
    /*
     * RED WHEN: the account half carries any blinding but the account's own - the change the chain
     * recorded, under the blinding the account was opened with, is then not the one the device built.
     */
    const onChain = (await c.ledger.status(c.account))!.openProposals.find((p) => p.id === round.chainId)!;
    expect(onChain.change).toBe(MidnightCommitments.changeCommitment(
      MidnightCommitments.assetKey('GBP', order.half.assetBlinding), BigInt(order.half.changeAmount),
      order.half.changeBatchDigest, order.half.proposalSalt));
    const after = await c.accounts.refreshStanding(round.id, c.viewingKey);
    /* RED WHEN: the read does not write down what the chain shows - the page then waits for ever. */
    expect(after.raisedAt).toBeDefined();
    expect(after.approvalRound).toEqual({ state: 'short', approvals: 0, threshold: 1 });
    expect(await c.payroll.raiseOrderOf(c.runId, c.viewingKey)).toBeNull();
    await expect(c.accounts.sendRaise(round.id, c.viewingKey, BYTES, c.me.signerId)).rejects.toThrow(/already holds this proposal/u);
  });

  it('THE STANDING READ NEVER PUTS BACK WHAT CHANGED WHILE IT WAS ASKING THE CHAIN', async () => {
    const c = await aCompany();
    const round = await c.raiseOnDevice();
    c.setEffect(c.theRaiseLands((await c.payroll.raiseOrderOf(c.runId, c.viewingKey))!));
    await c.accounts.sendRaise(round.id, c.viewingKey, BYTES, c.me.signerId);
    await c.accounts.refreshStanding(round.id, c.viewingKey);
    /* While the read waits on the chain, another request records an approval and then the proposal is withdrawn. */
    const status = c.ledger.status.bind(c.ledger);
    let first = true;
    Object.assign(c.ledger, {
      status: async (id: string) => {
        const answer = await status(id);
        if (first) {
          first = false;
          const p = c.accounts.requireProposal(round.id, c.viewingKey);
          p.status = 'cancelled';
          p.approvals = [{ signerId: 'sgn_other', signature: 'ab', at: 'then' }];
          (c.accounts as unknown as { putProposal(p: unknown, vk: string): void }).putProposal(p, c.viewingKey);
        }
        return answer;
      },
    });
    const after = await c.accounts.refreshStanding(round.id, c.viewingKey);
    /* RED WHEN: the record read before the chain answered is written back whole. */
    expect(after.status).toBe('cancelled');
    expect(c.accounts.requireProposal(round.id, c.viewingKey).status).toBe('cancelled');
    expect(c.accounts.requireProposal(round.id, c.viewingKey).approvals.map((a) => a.signerId)).toEqual(['sgn_other']);
  });

  it('A DEPLOYMENT WITH NO DOOR FOR A DEVICE\'S TRANSACTION REFUSES TO SEND, AND SAYS NOTHING WAS SENT', async () => {
    const c = await aCompany({ door: 'none' });
    const round = await c.raiseOnDevice();
    const refused = await c.accounts.sendRaise(round.id, c.viewingKey, BYTES, c.me.signerId).catch((e) => e);
    expect(saysNothingWasSent(refused)).toBe(true);
    expect(String(refused.message)).toMatch(/does not send transactions proved on a device/u);
    expect(String(refused.message)).toMatch(/Nothing was sent\.$/u);
    expect(c.accounts.requireProposal(round.id, c.viewingKey).txRef).toBeUndefined();
  });
});

describe('AN APPROVAL SENT FROM A DEVICE', () => {
  const aRoundOnChain = async () => {
    const c = await aCompany();
    const round = await c.raiseOnDevice();
    c.setEffect(c.theRaiseLands((await c.payroll.raiseOrderOf(c.runId, c.viewingKey))!));
    await c.accounts.sendRaise(round.id, c.viewingKey, BYTES, c.me.signerId);
    await c.accounts.refreshStanding(round.id, c.viewingKey);
    c.sent.length = 0;
    const fresh = c.accounts.requireProposal(round.id, c.viewingKey);
    const signature = sign(approvalMessage(fresh), c.me.signingSecret);
    return { ...c, round: fresh, signature };
  };

  it('IS SENT THROUGH THE DOOR IN PLACE OF A CHAIN CALL FROM HERE, AND IS RECORDED WITH ITS SIGNATURE', async () => {
    const c = await aRoundOnChain();
    c.setEffect(c.theApprovalLands(c.round.chainId));
    const approved = await c.accounts.approve(c.round.id, c.me.signerId, c.signature, c.viewingKey, BYTES);
    /* RED WHEN: the device's approval is not what is sent, or this process also approves from here. */
    expect(c.sent).toEqual([{ accountId: c.account, circuit: 'approve', bytes: [1, 2, 3, 4] }]);
    expect(approved.approvals.map((a) => a.signerId)).toEqual([c.me.signerId]);
    expect(approved.status).toBe('approved');
  });

  it('A REFUSAL BEFORE THE SEND SAYS NOTHING WAS SENT, AND NOTHING IS: a signature that does not verify, and an approval already recorded', async () => {
    const c = await aRoundOnChain();
    const forged = await c.accounts.approve(c.round.id, c.me.signerId, 'ab'.repeat(64), c.viewingKey, BYTES).catch((e) => e);
    /* RED WHEN: a refusal before the send is not marked - the device then tells a person their approval may have landed. */
    expect(saysNothingWasSent(forged)).toBe(true);
    expect(String(forged.message)).toMatch(/Nothing was sent\.$/u);
    expect(c.sent).toEqual([]);
    c.setEffect(c.theApprovalLands(c.round.chainId));
    await c.accounts.approve(c.round.id, c.me.signerId, c.signature, c.viewingKey, BYTES);
    const twice = await c.accounts.approve(c.round.id, c.me.signerId, c.signature, c.viewingKey, BYTES).catch((e) => e);
    expect(saysNothingWasSent(twice)).toBe(true);
    expect(String(twice.message)).toMatch(/already approved/u);
    expect(c.sent).toHaveLength(1);
  });

  it('A FAILURE FROM THE SEND ONWARDS IS NOT MARKED AS NOTHING SENT, AND NOTHING IS WRITTEN AS APPROVED', async () => {
    const c = await aRoundOnChain();
    c.setEffect(async () => { throw new Error('the node dropped the connection'); });
    const failed = await c.accounts.approve(c.round.id, c.me.signerId, c.signature, c.viewingKey, BYTES).catch((e) => e);
    /* RED WHEN: a failure at the send is marked as nothing sent - it may be an approval the chain holds. */
    expect(saysNothingWasSent(failed)).toBe(false);
    expect(String(failed.message)).toBe('the node dropped the connection');
    expect(c.accounts.requireProposal(c.round.id, c.viewingKey).approvals).toEqual([]);
  });

  it('WITHOUT A DEVICE\'S TRANSACTION, AN APPROVAL IS MADE AS IT ALWAYS WAS AND THE DOOR IS NOT USED', async () => {
    const c = await aRoundOnChain();
    const approved = await c.accounts.approve(c.round.id, c.me.signerId, c.signature, c.viewingKey);
    expect(c.sent).toEqual([]);
    expect(approved.status).toBe('approved');
  });
});

/**
 * **TWO REQUESTS ACT ON ONE PROPOSAL AT THE SAME TIME, AND THE RECORD IS RIGHT
 * AFTERWARDS.**
 *
 * A proposal can be raised and approved from signers' own devices, so two
 * devices, two tabs or two people can act on one proposal at once. Every case
 * here drives both writers: one request is held part way through its send to
 * the chain while the other runs, and then both are let go. What is pinned is
 * this service's record - which signatures it holds, whether it says withdrawn,
 * what count it shows, and how many transactions it handed over.
 *
 * The chain is the simulated ledger, and the door a device's transaction goes
 * through is a stand-in that records what it was handed and then does to the
 * simulated chain what the transaction would have done. These cases say nothing
 * about a real chain's timing; they say what this service writes whatever the
 * timing is.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountService, approvalMessage } from './account.js';
import { PayrollService } from './payroll.js';
import { SimulatedLedger, SimulatedProofSystem, type StateChange } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { runMaterialFor, retryMaterialFor } from '../midnight/run-material.js';
import { vaultDetails } from '../testing/vault-details.js';
import { registryWithTestPrivateForms, aVaultHolding } from '../testing/assets.js';
import { FileStore } from './store-file.js';
import { sign, toHex, type Hex } from './crypto.js';
import { saysNothingWasSent } from './jobs.js';

const VAULT = toHex(new Uint8Array(32).fill(0xa1));
const now = () => Math.floor(Date.now() / 1000);
const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** A send the test lets go of when it chooses. */
const aGate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { opened, open };
};

/** Resolves once `test` holds, polling the event loop rather than a clock. */
const until = async (test: () => boolean) => {
  for (let i = 0; i < 1_000 && !test(); i++) await new Promise((r) => setImmediate(r));
  if (!test()) throw new Error('what the test was waiting for never happened');
};

type Ada = 0; type Blake = 1;

async function aCompany(opts: { threshold: number }) {
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-one-writer-')), 'db.json'));
  const ledger = new SimulatedLedger(MidnightCommitments);
  /*
   * A DOUBLE, NAMED: the simulated ledger records no payments and answers that it cannot say who was
   * paid, and a retry is refused until that can be said. Here the account records nobody paid.
   */
  Object.assign(ledger, { paidAmong: async () => ({ known: true, paid: [] }) });
  /** Every transaction a device handed to the door, in order: which call, and whose device built it. */
  const sent: Array<{ circuit: string; by: string }> = [];
  /** What the door does with the next call; the default lands it on the chain at once. */
  let door: (circuit: string, by: string, land: () => Promise<{ ref: string; at: string }>) =>
    Promise<{ ref: string; at: string }> = (_c, _b, land) => land();
  const registry = registryWithTestPrivateForms();
  /** The vault check a raise makes before it writes its proposal; a test may hold the next one. */
  const vault = aVaultHolding();
  let vaultRead: { opened: Promise<void>; asked: boolean } | null = null;
  const holdings: typeof vault = {
    ...vault,
    held: async (...args: Parameters<typeof vault.held>) => {
      const hold = vaultRead;
      if (hold) { vaultRead = null; hold.asked = true; await hold.opened; }
      return vault.held(...args);
    },
  };
  const accounts = new AccountService(store, ledger, MidnightCommitments, registry, holdings,
    { everyMs: 0, attempts: 4 });
  const payroll = new PayrollService(store, accounts, new SimulatedProofSystem(), registry);
  const created = await accounts.create('Northwind Ltd', [
    { name: 'Ada', role: 'admin' }, { name: 'Blake', role: 'approver' }, { name: 'Cleo', role: 'approver' },
  ], opts.threshold);
  const viewingKey = created.viewingKey;
  const account = created.account.id;
  for (let i = 0; i < 3; i++) {
    payroll.hireDirect(account, {
      name: `Payee ${i}`, email: `p${i}@a.co`, title: 'Eng', asset: 'GBP', baseAmount: 100_00n,
    }, viewingKey);
  }
  const seats = created.secrets;
  const leafOf = (signerId: string) =>
    accounts.open(account, viewingKey).signers.find((x) => x.id === signerId)!.leafCommitment as Hex;
  const by = (signerId: string) => ({ signerId, leaf: leafOf(signerId) });
  const window = { opensAt: BigInt(now() - 60), closesAt: BigInt(now() + 3_600) };
  const drawn = await payroll.createRunFromRoster(account, '2026-08', viewingKey);
  const runId = drawn.run.id;
  const materialFor = async () => {
    const i = await payroll.runMaterialInputs(runId, viewingKey);
    return runMaterialFor({
      accountId: i.accountId, runId: i.runId, seeds: i.seeds, facts: i.facts,
      opensAt: window.opensAt, closesAt: window.closesAt, vault: VAULT, detailsOf: vaultDetails,
      ...(i.epoch !== undefined ? { epoch: i.epoch } : {}),
    });
  };
  const raiseOnDevice = async () =>
    payroll.proposeRun(runId, viewingKey, seats[0]!.signerId, await materialFor(), undefined, { onDevice: true });

  Object.assign(ledger, {
    submitProvenCall: async (accountId: string, bytes: Uint8Array, circuit: string) => {
      const [who, chainId] = decode(bytes).split(' ') as [string, Hex];
      sent.push({ circuit, by: who });
      const land = async () => {
        if (circuit === 'approve') return ledger.approve(accountId, chainId, by(who));
        const order = (await payroll.raiseOrderOf(runId, viewingKey))!;
        const change: StateChange = {
          asset: 'GBP', amount: BigInt(order.half.changeAmount), batchDigest: order.half.changeBatchDigest,
          salt: order.half.proposalSalt,
        };
        const r = await ledger.proposeRun(accountId, order.run, change, by(who));
        return { ref: `tx_${r.proposalId.slice(0, 8)}`, at: r.at };
      };
      return door(circuit, who, land);
    },
  });

  /** What one signer's device sends: its own approval, of the round it names. */
  const approvalFrom = (seat: Ada | Blake | 2, round: { id: string; chainId: Hex }) => {
    const s = seats[seat]!;
    const current = accounts.requireProposal(round.id, viewingKey);
    return accounts.approve(round.id, s.signerId, sign(approvalMessage(current), s.signingSecret), viewingKey,
      encode(`${s.signerId} ${round.chainId}`));
  };
  const raiseSentFrom = (round: { id: string; chainId: Hex }) =>
    accounts.sendRaise(round.id, viewingKey, encode(`${seats[0]!.signerId} ${round.chainId}`), seats[0]!.signerId);
  /** A proposal written down, sent, and seen on the chain. */
  const aRoundOnChain = async () => {
    const round = await raiseOnDevice();
    await raiseSentFrom(round);
    await accounts.refreshStanding(round.id, viewingKey);
    sent.length = 0;
    return accounts.requireProposal(round.id, viewingKey);
  };
  /**
   * Holds the `nth` chain read made from now on after it has been answered, so the answer is
   * the chain as it was then and the caller gets it only when the test lets go.
   */
  const holdChainRead = (nth: number) => {
    const gate = aGate();
    const status = ledger.status.bind(ledger);
    let calls = 0;
    Object.assign(ledger, {
      status: async (id: string) => {
        const answer = await status(id);
        calls += 1;
        if (calls === nth) await gate.opened;
        return answer;
      },
    });
    return { ...gate, reads: () => calls };
  };
  const onChain = async (chainId: Hex) =>
    (await ledger.status(account))?.openProposals.find((p) => p.id === chainId);
  return {
    accounts, payroll, ledger, viewingKey, account, seats, runId, sent, raiseOnDevice, raiseSentFrom,
    approvalFrom, aRoundOnChain, onChain, by, VAULT, window, holdChainRead, materialFor,
    setDoor: (d: typeof door) => { door = d; },
    holdVaultRead: () => {
      const gate = aGate();
      const hold = { opened: gate.opened, asked: false };
      vaultRead = hold;
      return { open: gate.open, asked: () => hold.asked };
    },
    record: (id: string) => accounts.requireProposal(id, viewingKey),
  };
}

describe('TWO SIGNERS APPROVING AT ONCE', () => {
  it('BOTH SIGNATURES ARE ON THE RECORD, AND THE COUNT IS THE CHAIN\'S', async () => {
    const c = await aCompany({ threshold: 3 });
    const round = await c.aRoundOnChain();
    const gate = aGate();
    c.setDoor(async (_c, _b, land) => { const r = await land(); await gate.opened; return r; });
    const ada = c.approvalFrom(0, round);
    const blake = c.approvalFrom(1, round);
    await until(() => c.sent.length === 2);
    gate.open();
    await Promise.all([ada, blake]);
    const after = c.record(round.id);
    /* RED WHEN: an approval writes back the record it read before its send - the second write then drops the first signature. */
    expect(after.approvals.map((a) => a.signerId).sort()).toEqual([c.seats[0]!.signerId, c.seats[1]!.signerId].sort());
    expect((await c.onChain(round.chainId))!.approvals).toBe(2);
    /* RED WHEN: the standing either request read before the other landed is written over the later one. */
    expect(after.approvalRound).toEqual({ state: 'short', approvals: 2, threshold: 3 });
    expect(after.status).toBe('open');
  });

  it('A WITHDRAWAL THAT LANDS WHILE AN APPROVAL IS BEING SENT STAYS A WITHDRAWAL', async () => {
    const c = await aCompany({ threshold: 3 });
    const round = await c.aRoundOnChain();
    const gate = aGate();
    c.setDoor(async (_c, _b, land) => { const r = await land(); await gate.opened; return r; });
    const ada = c.approvalFrom(0, round).catch((e) => e);
    await until(() => c.sent.length === 1);
    const withdrawn = await c.accounts.cancel(round.id, c.viewingKey);
    expect(withdrawn.status).toBe('cancelled');
    gate.open();
    const answer = await ada;
    /* RED WHEN: the approval's write puts back the open record it read before the withdrawal. */
    expect(c.record(round.id).status).toBe('cancelled');
    expect(c.record(round.id).approvals).toEqual([]);
    /* RED WHEN: the approval is reported as recorded, or as nothing sent - it was sent, and may have been counted before the withdrawal. */
    expect(answer).toBeInstanceOf(Error);
    expect(saysNothingWasSent(answer)).toBe(false);
    expect(String(answer.message)).toMatch(/withdrawn while this approval was being sent/u);
  });
});

describe('ONE THING SENT TWICE AT ONCE IS HANDED OVER ONCE', () => {
  it('A PROPOSAL SENT FROM TWO TABS AT ONCE: ONE TRANSACTION, AND THE OTHER SAYS NOTHING WAS SENT', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.raiseOnDevice();
    const gate = aGate();
    c.setDoor(async (_c, _b, land) => { await gate.opened; return land(); });
    const first = c.raiseSentFrom(round);
    await until(() => c.sent.length === 1);
    const pending = c.raiseSentFrom(round).catch((e) => e);
    await Promise.race([pending, until(() => c.sent.length === 2).catch(() => undefined)]);
    /* RED WHEN: both sends pass the check before either is written - both are then submitted, and the chain refuses one after its fee. */
    expect(c.sent).toHaveLength(1);
    const second = await pending;
    expect(saysNothingWasSent(second)).toBe(true);
    expect(String(second.message)).toMatch(/is being sent to the chain right now/u);
    /* RED WHEN: a withdrawal closes the record while its send is on the way - if the send lands, nothing here can withdraw it. */
    const cancel = await c.accounts.cancel(round.id, c.viewingKey).catch((e) => e);
    expect(String(cancel.message)).toMatch(/is being sent to the chain right now.*Nothing was withdrawn/su);
    expect(c.record(round.id).status).toBe('open');
    gate.open();
    expect((await first).txRef).toMatch(/^tx_/u);
    /* And once the first has answered, the one sent is the one the chain holds, and it is not sent again. */
    await c.accounts.refreshStanding(round.id, c.viewingKey);
    await expect(c.raiseSentFrom(round)).rejects.toThrow(/already holds this proposal/u);
    expect(c.sent).toHaveLength(1);
  });

  it('ONE SIGNER APPROVING FROM TWO TABS AT ONCE: ONE TRANSACTION, ONE SIGNATURE', async () => {
    const c = await aCompany({ threshold: 3 });
    const round = await c.aRoundOnChain();
    const gate = aGate();
    c.setDoor(async (_c, _b, land) => { await gate.opened; return land(); });
    const first = c.approvalFrom(0, round);
    await until(() => c.sent.length === 1);
    const pending = c.approvalFrom(0, round).catch((e) => e);
    await Promise.race([pending, until(() => c.sent.length === 2).catch(() => undefined)]);
    /* RED WHEN: the second approval is checked against a record the first has not written yet, and is sent too. */
    expect(c.sent).toHaveLength(1);
    const second = await pending;
    expect(saysNothingWasSent(second)).toBe(true);
    expect(String(second.message)).toMatch(/is being sent to the chain right now/u);
    gate.open();
    await first;
    expect(c.record(round.id).approvals.map((a) => a.signerId)).toEqual([c.seats[0]!.signerId]);
    /* The hold is released when the send answers: another signer is not held by it, and this one is told it has approved. */
    await expect(c.approvalFrom(0, round)).rejects.toThrow(/already approved/u);
    await c.approvalFrom(1, round);
    expect(c.sent).toHaveLength(2);
  });

  it('A SEND THAT FAILS RELEASES ITS HOLD, SO THE SAME SEND CAN BE MADE AGAIN', async () => {
    const c = await aCompany({ threshold: 3 });
    const round = await c.aRoundOnChain();
    c.setDoor(async () => { throw new Error('the node dropped the connection'); });
    await expect(c.approvalFrom(0, round)).rejects.toThrow(/dropped the connection/u);
    c.setDoor((_c, _b, land) => land());
    /* RED WHEN: a failed send keeps its hold - one unreachable node then refuses this signer for ever. */
    const again = await c.approvalFrom(0, round);
    expect(again.approvals.map((a) => a.signerId)).toEqual([c.seats[0]!.signerId]);
  });
});

describe('THE LAST APPROVAL FROM A DEVICE', () => {
  it('IS RECORDED AS APPROVED WHEN THE CHAIN COUNTS IT, THOUGH NOBODY ASKS AGAIN', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.aRoundOnChain();
    /* The door answers when the transaction is handed over; the chain counts it a moment later. */
    let later: (() => Promise<unknown>) | null = null;
    c.setDoor(async (_c, _b, land) => { later = land; return { ref: 'tx_handed_over', at: new Date().toISOString() }; });
    const status = c.ledger.status.bind(c.ledger);
    let reads = 0;
    Object.assign(c.ledger, {
      status: async (id: string) => {
        reads += 1;
        if (reads === 2 && later) { await later(); later = null; }
        return status(id);
      },
    });
    const answered = await c.approvalFrom(0, round);
    /* RED WHEN: the standing is read once, before the chain can have counted the approval, and never again. */
    expect(c.record(round.id).status).toBe('approved');
    expect(answered.status).toBe('approved');
    expect(c.record(round.id).approvalRound).toEqual({ state: 'satisfied', approvals: 1, threshold: 1 });
  });

  it('A SEND THE CHAIN NEVER COUNTS STOPS BEING WAITED FOR, AND THE RECORD SAYS WHAT THE CHAIN SAID', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.aRoundOnChain();
    c.setDoor(async () => ({ ref: 'tx_dropped', at: new Date().toISOString() }));
    const status = c.ledger.status.bind(c.ledger);
    let reads = 0;
    Object.assign(c.ledger, { status: async (id: string) => { reads += 1; return status(id); } });
    const answered = await c.approvalFrom(0, round);
    /* RED WHEN: the wait is unbounded - a dropped transaction then holds the request for ever. */
    expect(reads).toBe(4);
    expect(answered.status).toBe('open');
    expect(c.record(round.id).approvalRound).toEqual({ state: 'short', approvals: 0, threshold: 1 });
    /* The signature is still the service's to hold: the device sent it. */
    expect(c.record(round.id).approvals.map((a) => a.signerId)).toEqual([c.seats[0]!.signerId]);
  });

  it('AN APPROVAL MADE FROM HERE IS NOT WAITED ON, EVEN WHEN THE CHAIN DOES NOT ANSWER THE STANDING', async () => {
    const c = await aCompany({ threshold: 3 });
    const round = await c.aRoundOnChain();
    let reads = 0;
    Object.assign(c.ledger, { status: async () => { reads += 1; return null; } });
    const s = c.seats[0]!;
    const approved = await c.accounts.approve(round.id, s.signerId, sign(approvalMessage(round), s.signingSecret), c.viewingKey);
    /* RED WHEN: the wait for a device's transaction is applied to every approval - each then costs a chain read per attempt. */
    expect(reads).toBe(1);
    expect(approved.approvalRound).toEqual({ state: 'unknown', why: 'no-status' });
  });

  it('AN APPROVED PROPOSAL IS NEVER GIVEN A LOWER COUNT BY A LATER APPROVAL\'S READ', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.aRoundOnChain();
    const [ada, blake] = [c.seats[0]!, c.seats[1]!];
    await c.accounts.approve(round.id, ada.signerId, sign(approvalMessage(round), ada.signingSecret), c.viewingKey);
    expect(c.record(round.id).approvalRound).toEqual({ state: 'satisfied', approvals: 1, threshold: 1 });
    /* Blake approves too, and the read after it answers from a chain that has not caught up. */
    const status = c.ledger.status.bind(c.ledger);
    Object.assign(c.ledger, {
      status: async (id: string) => {
        const answer = (await status(id))!;
        return { ...answer, openProposals: answer.openProposals.map((p) => ({ ...p, approvals: 0 })) };
      },
    });
    const after = await c.accounts.approve(round.id, blake.signerId, sign(approvalMessage(round), blake.signingSecret), c.viewingKey);
    /* RED WHEN: an approved record takes whatever a read says whenever nobody else wrote meanwhile. */
    expect(after.status).toBe('approved');
    expect(after.approvalRound).toEqual({ state: 'satisfied', approvals: 1, threshold: 1 });
    expect(after.approvals.map((a) => a.signerId)).toEqual([ada.signerId, blake.signerId]);
  });

  it('A LATER READ THAT FAILS ENDS THE WAIT, AND THE APPROVAL STANDS', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.aRoundOnChain();
    c.setDoor(async () => ({ ref: 'tx_handed_over', at: new Date().toISOString() }));
    const status = c.ledger.status.bind(c.ledger);
    let reads = 0;
    Object.assign(c.ledger, {
      status: async (id: string) => {
        reads += 1;
        if (reads === 2) throw new Error('the indexer went away');
        return status(id);
      },
    });
    const answered = await c.approvalFrom(0, round);
    /* RED WHEN: a failed later read is thrown to a device whose approval was sent and recorded - it is then told the approval failed. */
    expect(reads).toBe(2);
    expect(answered.approvals.map((a) => a.signerId)).toEqual([c.seats[0]!.signerId]);
    expect(c.record(round.id).approvals.map((a) => a.signerId)).toEqual([c.seats[0]!.signerId]);
  });

  it('A WITHDRAWAL THAT LANDS WHILE THE STANDING IS BEING READ STAYS A WITHDRAWAL', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.aRoundOnChain();
    const held = c.holdChainRead(1);
    const s = c.seats[0]!;
    /* The chain counts the approval and answers `satisfied`; the answer is held while the proposal is withdrawn. */
    const approving = c.accounts.approve(round.id, s.signerId, sign(approvalMessage(round), s.signingSecret), c.viewingKey);
    await until(() => held.reads() === 1);
    await c.accounts.cancel(round.id, c.viewingKey);
    held.open();
    const answered = await approving;
    /* RED WHEN: the standing is written onto a withdrawn record - `satisfied` then turns it back into `approved`. */
    expect(c.record(round.id).status).toBe('cancelled');
    expect(answered.status).toBe('cancelled');
  });
});

describe('A SEND IS CHECKED AGAIN AFTER THE CHAIN IS ASKED', () => {
  it('AN APPROVAL THAT WAITED ON THE CHAIN IS NOT SENT IF THE SAME SIGNER\'S APPROVAL WAS RECORDED MEANWHILE', async () => {
    const c = await aCompany({ threshold: 3 });
    const round = await c.raiseOnDevice();
    await c.raiseSentFrom(round);
    c.sent.length = 0;
    /* The chain holds the proposal and this record has not been told: an approval asks the chain first. */
    const held = c.holdChainRead(1);
    const waiting = c.approvalFrom(0, round).catch((e) => e);
    await until(() => held.reads() === 1);
    await c.approvalFrom(0, round);
    expect(c.sent).toHaveLength(1);
    held.open();
    const second = await waiting;
    /* RED WHEN: the approval is sent on the strength of the record it read before the chain answered. */
    expect(c.sent).toHaveLength(1);
    expect(saysNothingWasSent(second)).toBe(true);
    expect(String(second.message)).toMatch(/already approved/u);
  });

  it('A PROPOSAL WITHDRAWN WHILE AN APPROVAL WAITED ON THE CHAIN IS SENT NO APPROVAL', async () => {
    const c = await aCompany({ threshold: 3 });
    const round = await c.raiseOnDevice();
    await c.raiseSentFrom(round);
    c.sent.length = 0;
    const held = c.holdChainRead(1);
    const waiting = c.approvalFrom(0, round).catch((e) => e);
    await until(() => held.reads() === 1);
    await c.accounts.cancel(round.id, c.viewingKey);
    held.open();
    const refused = await waiting;
    /* RED WHEN: a withdrawn proposal is sent an approval - a fee for a call the record will never hold. */
    expect(c.sent).toEqual([]);
    expect(saysNothingWasSent(refused)).toBe(true);
    expect(String(refused.message)).toMatch(/this proposal was withdrawn, so it takes no approvals/u);
  });

  it('A PROPOSAL SENT BY ANOTHER REQUEST WHILE THE CHAIN WAS ASKED ABOUT IT IS NOT SENT AGAIN', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.raiseOnDevice();
    /* A first send is handed over and never arrives, so a second one asks the chain. */
    c.setDoor(async () => ({ ref: 'tx_dropped', at: new Date().toISOString() }));
    await c.raiseSentFrom(round);
    c.setDoor((_c, _b, land) => land());
    const held = c.holdChainRead(1);
    const late = c.raiseSentFrom(round).catch((e) => e);
    await until(() => held.reads() === 1);
    await c.raiseSentFrom(round);
    expect(c.sent).toHaveLength(2);
    held.open();
    const refused = await late;
    /* RED WHEN: the send goes on an answer about a record another request has since sent. */
    expect(c.sent).toHaveLength(2);
    expect(saysNothingWasSent(refused)).toBe(true);
    expect(String(refused.message)).toMatch(/sent by another request while the chain was being asked/u);
  });

  it('A PROPOSAL SEEN ON THE CHAIN WHILE A SEND ASKED ABOUT IT IS NOT SENT AGAIN', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.raiseOnDevice();
    let arrive: (() => Promise<unknown>) | null = null;
    c.setDoor(async (_c, _b, land) => { arrive = land; return { ref: 'tx_slow', at: new Date().toISOString() }; });
    await c.raiseSentFrom(round);
    const held = c.holdChainRead(1);
    const late = c.raiseSentFrom(round).catch((e) => e);
    await until(() => held.reads() === 1);
    /* The first send arrives, and another request sees it. */
    await arrive!();
    await c.accounts.refreshStanding(round.id, c.viewingKey);
    expect(c.record(round.id).raisedAt).toBeDefined();
    held.open();
    const refused = await late;
    /* RED WHEN: the send goes on the chain's earlier answer, after the record says the chain holds it. */
    expect(c.sent).toHaveLength(1);
    expect(saysNothingWasSent(refused)).toBe(true);
    expect(String(refused.message)).toMatch(/already holds this proposal/u);
  });
});

describe('A WITHDRAWAL IS WRITTEN ONLY IF WHAT THE CHAIN WAS ASKED ABOUT IS STILL THE RECORD', () => {
  it('A WITHDRAWAL AND A FIRST SEND THAT MEET ARE NEVER BOTH WRITTEN, AT ANY INTERLEAVING', async () => {
    const outcomes: string[] = [];
    for (let ticks = 0; ticks < 16; ticks++) {
      const c = await aCompany({ threshold: 1 });
      const round = await c.raiseOnDevice();
      const held = c.holdChainRead(1);
      const withdrawing = c.accounts.cancel(round.id, c.viewingKey).then(() => 'withdrawn', () => 'kept');
      await until(() => held.reads() === 1);
      let sending: Promise<string>;
      if (ticks % 2 === 0) {
        held.open();
        for (let t = 0; t < ticks / 2; t++) await null;
        sending = c.raiseSentFrom(round).then(() => 'sent', () => 'not sent');
      } else {
        sending = c.raiseSentFrom(round).then(() => 'sent', () => 'not sent');
        for (let t = 0; t < (ticks - 1) / 2; t++) await null;
        held.open();
      }
      const both = `${await withdrawing} ${await sending}`;
      outcomes.push(both);
      /* RED WHEN: a send goes to a proposal a withdrawal closed after the send had looked at it. */
      expect(both === 'withdrawn sent' && c.record(round.id).status === 'cancelled', both).toBe(false);
    }
    /* Both orders were met: the sweep is not measuring one schedule twelve times. */
    expect(new Set(outcomes).size, outcomes.join(', ')).toBeGreaterThan(1);
  });


  it('ONE THE CHAIN CARRIES OUT KEEPS WHAT ANOTHER REQUEST RECORDED WHILE IT WAS BEING CARRIED OUT', async () => {
    const c = await aCompany({ threshold: 3 });
    const round = await c.aRoundOnChain();
    const withdraw = c.ledger.cancel.bind(c.ledger);
    const onChain = aGate();
    let asked = false;
    Object.assign(c.ledger, {
      cancel: async (...args: Parameters<typeof withdraw>) => { asked = true; await onChain.opened; return withdraw(...args); },
    });
    const withdrawing = c.accounts.cancel(round.id, c.viewingKey);
    await until(() => asked);
    /* Meanwhile an approval that does not verify is refused, and the refusal is recorded. */
    await expect(c.accounts.approve(round.id, c.seats[1]!.signerId, 'ab'.repeat(64), c.viewingKey))
      .rejects.toThrow(/signature does not match/u);
    expect(c.record(round.id).refusedApprovals?.count).toBe(1);
    onChain.open();
    const withdrawn = await withdrawing;
    /* RED WHEN: the withdrawal writes back the record it read before the chain call - the refusal then vanishes. */
    expect(withdrawn.status).toBe('cancelled');
    expect(c.record(round.id).status).toBe('cancelled');
    expect(c.record(round.id).refusedApprovals?.count).toBe(1);
  });

  it('ONE THAT STARTED BEFORE A RAISE WAS SENT DOES NOT CLOSE IT WHILE THE RAISE IS ON ITS WAY', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.raiseOnDevice();
    const held = c.holdChainRead(1);
    const withdrawing = c.accounts.cancel(round.id, c.viewingKey).catch((e) => e);
    await until(() => held.reads() === 1);
    const door = aGate();
    c.setDoor(async (_c, _b, land) => { await door.opened; return land(); });
    const sending = c.raiseSentFrom(round);
    await until(() => c.sent.length === 1);
    held.open();
    const refused = await withdrawing;
    /* RED WHEN: the withdrawal closes the record while the raise is on its way - if it lands, nothing here can withdraw it. */
    expect(String(refused.message)).toMatch(/is being sent to the chain right now.*Nothing was withdrawn/su);
    expect(c.record(round.id).status).toBe('open');
    door.open();
    await sending;
  });

  it('ONE THAT STARTED BEFORE A RAISE WAS SENT DOES NOT CLOSE IT ONCE THE RAISE HAS BEEN SENT', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.raiseOnDevice();
    const held = c.holdChainRead(1);
    const withdrawing = c.accounts.cancel(round.id, c.viewingKey).catch((e) => e);
    await until(() => held.reads() === 1);
    await c.raiseSentFrom(round);
    held.open();
    const refused = await withdrawing;
    /* RED WHEN: the withdrawal is written on the chain's answer about a record that had not been sent. */
    expect(String(refused.message)).toMatch(/sent to the chain while it was being withdrawn.*Nothing was withdrawn/su);
    expect(c.record(round.id).status).toBe('open');
  });

  it('ONE WHOSE ANSWER WAS "NOT ON THE CHAIN" DOES NOT CLOSE A PROPOSAL ANOTHER REQUEST HAS SINCE SEEN THERE', async () => {
    const c = await aCompany({ threshold: 1 });
    /* Raised from here: the chain call lands and its answer is lost, so the record says neither sent nor seen. */
    const propose = c.ledger.proposeRun.bind(c.ledger);
    const landing = aGate();
    Object.assign(c.ledger, {
      proposeRun: async (...args: Parameters<typeof propose>) => {
        await landing.opened;
        await propose(...args);
        throw new Error('the answer was lost');
      },
    });
    const raising = c.payroll.proposeRun(c.runId, c.viewingKey, c.seats[0]!.signerId, await c.materialFor()).catch((e) => e);
    const id = await (async () => {
      await until(() => c.accounts.listProposals(c.account, c.viewingKey).length === 1);
      return c.accounts.listProposals(c.account, c.viewingKey)[0]!.id;
    })();
    const held = c.holdChainRead(1);
    const withdrawing = c.accounts.cancel(id, c.viewingKey).catch((e) => e);
    await until(() => held.reads() === 1);
    landing.open();
    expect(String((await raising).message)).toMatch(/answer was lost/u);
    await c.accounts.refreshStanding(id, c.viewingKey);
    expect(c.record(id).raisedAt).toBeDefined();
    expect(c.record(id).txRef).toBeUndefined();
    held.open();
    const refused = await withdrawing;
    /* RED WHEN: a record the chain has since been seen to hold is closed here on the earlier answer. */
    expect(String(refused.message)).toMatch(/Nothing was withdrawn/u);
    expect(c.record(id).status).toBe('open');
  });
});

describe('ONE LEG RAISED TWICE AT ONCE', () => {
  it('IS RAISED ONCE, AND THE OTHER REQUEST IS TOLD NOTHING WAS RAISED', async () => {
    const c = await aCompany({ threshold: 1 });
    const propose = c.ledger.proposeRun.bind(c.ledger);
    const onChain = aGate();
    let asked = 0;
    Object.assign(c.ledger, {
      proposeRun: async (...args: Parameters<typeof propose>) => { asked += 1; await onChain.opened; return propose(...args); },
    });
    const raise = async () => c.payroll.proposeRun(c.runId, c.viewingKey, c.seats[0]!.signerId, await c.materialFor());
    const first = raise();
    await until(() => asked === 1);
    const second = await raise().catch((e) => e);
    onChain.open();
    await first;
    /* RED WHEN: both raises find the leg unraised before either answers - two proposals over the same people reach the chain. */
    expect(String(second.message)).toMatch(/is being raised right now by another request.*Nothing was raised/su);
    expect(asked).toBe(1);
    expect(c.accounts.payrollRoundsOf(c.account, c.viewingKey)).toHaveLength(1);
  });

  it('A WITHDRAWAL WHILE A RAISE FROM HERE IS ON ITS WAY DOES NOT CLOSE IT, AND THE LEG IS NOT RAISED OVER IT', async () => {
    const c = await aCompany({ threshold: 1 });
    const propose = c.ledger.proposeRun.bind(c.ledger);
    const onChain = aGate();
    let asked = false;
    Object.assign(c.ledger, {
      proposeRun: async (...args: Parameters<typeof propose>) => { asked = true; await onChain.opened; return propose(...args); },
    });
    const raising = c.payroll.proposeRun(c.runId, c.viewingKey, c.seats[0]!.signerId, await c.materialFor());
    await until(() => asked);
    const [written] = c.accounts.listProposals(c.account, c.viewingKey);
    /* RED WHEN: the withdrawal closes the record while the raise may still land - the raise then writes it open again, or nothing here can withdraw it. */
    await expect(c.accounts.cancel(written!.id, c.viewingKey)).rejects.toThrow(/is being sent to the chain right now.*Nothing was withdrawn/su);
    await expect(c.raiseOnDevice()).rejects.toThrow(/is being raised right now/u);
    /* Meanwhile an approval that does not verify is refused, and the refusal is recorded. */
    await expect(c.accounts.approve(written!.id, c.seats[1]!.signerId, 'ab'.repeat(64), c.viewingKey))
      .rejects.toThrow(/signature does not match/u);
    onChain.open();
    const raised = await raising;
    /* RED WHEN: the raise's confirmation is written onto the record it held before the chain call - the refusal vanishes. */
    expect(c.record(raised.id).refusedApprovals?.count).toBe(1);
    expect(c.record(raised.id).status).toBe('open');
    expect(c.record(raised.id).raisedAt).toBeDefined();
    /* And once it has answered, it is withdrawn through the chain like any other. */
    expect((await c.accounts.cancel(raised.id, c.viewingKey)).status).toBe('cancelled');
    expect(await c.onChain(raised.chainId)).toBeUndefined();
  });
});

describe('A RUN RAISED AGAIN FROM HERE', () => {
  /** A raise from here whose chain call fails before it lands: the record exists, unconfirmed. */
  const aRaiseThatDidNotLand = async (c: Awaited<ReturnType<typeof aCompany>>) => {
    const propose = c.ledger.proposeRun.bind(c.ledger);
    let fail = true;
    Object.assign(c.ledger, {
      proposeRun: async (...args: Parameters<typeof propose>) => {
        if (fail) { fail = false; throw new Error('the node refused before it landed'); }
        return propose(...args);
      },
    });
    await expect(c.payroll.proposeRun(c.runId, c.viewingKey, c.seats[0]!.signerId, await c.materialFor()))
      .rejects.toThrow(/refused before it landed/u);
    const [written] = c.accounts.listProposals(c.account, c.viewingKey);
    expect(written!.raisedAt).toBeUndefined();
    return written!;
  };

  it('A WITHDRAWAL WHILE IT IS BEING RAISED AGAIN IS REFUSED, AND THE RAISE LANDS AS ITSELF', async () => {
    const c = await aCompany({ threshold: 1 });
    const written = await aRaiseThatDidNotLand(c);
    const material = await c.materialFor();
    const check = c.holdVaultRead();
    const again = c.payroll.proposeRun(c.runId, c.viewingKey, c.seats[0]!.signerId, material);
    await until(() => check.asked());
    /* RED WHEN: the withdrawal closes the record and the raise then writes it back open - withdrawn here, open on chain. */
    await expect(c.accounts.cancel(written.id, c.viewingKey)).rejects.toThrow(/is being sent to the chain right now.*Nothing was withdrawn/su);
    check.open();
    const raised = await again;
    expect(raised.id).toBe(written.id);
    expect(c.record(written.id).status).toBe('open');
    expect(await c.onChain(written.chainId)).toBeDefined();
  });

  it('A RECORD WITHDRAWN BEFORE THE RAISE HELD IT IS NOT REOPENED', async () => {
    const c = await aCompany({ threshold: 1 });
    const written = await aRaiseThatDidNotLand(c);
    /* The raise again asks the chain whether the record is there; the withdrawal lands while it waits. */
    const material = await c.materialFor();
    const held = c.holdChainRead(1);
    const again = c.payroll.proposeRun(c.runId, c.viewingKey, c.seats[0]!.signerId, material).catch((e) => e);
    await until(() => held.reads() === 1);
    expect((await c.accounts.cancel(written.id, c.viewingKey)).status).toBe('cancelled');
    held.open();
    const refused = await again;
    /* RED WHEN: the raise writes back the open record it read before the withdrawal, and sends it. */
    expect(String(refused.message)).toMatch(/this proposal is cancelled now, so it was not raised again\. Nothing was raised/u);
    expect(c.record(written.id).status).toBe('cancelled');
    expect(await c.onChain(written.chainId)).toBeUndefined();
  });
});

describe('A WITHDRAWN LEG', () => {
  it('IS RAISED AGAIN, AS A NEW PROPOSAL, AND THE RUN POINTS AT THE NEW ONE', async () => {
    const c = await aCompany({ threshold: 1 });
    const first = await c.raiseOnDevice();
    await expect(c.raiseOnDevice()).rejects.toThrow(/already proposed/u);
    await c.accounts.cancel(first.id, c.viewingKey);
    /* RED WHEN: the leg remembers the withdrawn proposal as its own - it is then refused for ever. */
    const second = await c.raiseOnDevice();
    expect(second.id).not.toBe(first.id);
    expect(second.chainId).not.toBe(first.chainId);
    expect(c.payroll.requireRun(c.runId, c.viewingKey).proposalIds.GBP).toBe(second.id);
    /* RED WHEN: the release is wider than a withdrawal - a leg whose proposal stands is raised a second time. */
    await expect(c.raiseOnDevice()).rejects.toThrow(/already proposed/u);
    /* And what the device builds now is the new proposal, not the withdrawn one. */
    expect((await c.payroll.raiseOrderOf(c.runId, c.viewingKey))!.proposalId).toBe(second.id);
  });

  it('AN APPROVED LEG IS NOT RELEASED', async () => {
    const c = await aCompany({ threshold: 1 });
    const round = await c.aRoundOnChain();
    const s = c.seats[0]!;
    expect((await c.accounts.approve(round.id, s.signerId, sign(approvalMessage(round), s.signingSecret), c.viewingKey)).status)
      .toBe('approved');
    /* RED WHEN: the release is wider than a withdrawal - an approved leg is raised a second time over the same people. */
    await expect(c.raiseOnDevice()).rejects.toThrow(/already proposed/u);
  });

  it('IS RAISED AGAIN AFTER THE CHAIN HELD IT AND IT WAS WITHDRAWN THERE', async () => {
    const c = await aCompany({ threshold: 1 });
    const first = await c.aRoundOnChain();
    await c.accounts.cancel(first.id, c.viewingKey);
    expect(await c.onChain(first.chainId)).toBeUndefined();
    const second = await c.raiseOnDevice();
    await c.raiseSentFrom(second);
    await c.accounts.refreshStanding(second.id, c.viewingKey);
    expect(await c.onChain(second.chainId)).toBeDefined();
    expect(c.record(second.id).raisedAt).toBeDefined();
  });

  it('IS NOT RAISED AGAIN WHILE A RETRY ON IT IS BEING RAISED, AND THE RETRY KEEPS ITS MATERIAL', async () => {
    const c = await aCompany({ threshold: 1 });
    const first = await c.aRoundOnChain();
    await c.accounts.cancel(first.id, c.viewingKey);
    const rebuild = (await c.payroll.payoutRebuildOf(c.runId, c.viewingKey))!;
    const material = await retryMaterialFor({
      rebuild, indices: [0], opensAt: c.window.opensAt, closesAt: c.window.closesAt, vault: c.VAULT,
      detailsOf: vaultDetails,
    });
    /*
     * The retry has written itself onto the leg and is held at the vault check, before its own
     * proposal is written: nothing yet says a retry on this leg is live.
     */
    const check = c.holdVaultRead();
    const retrying = c.payroll.proposeRetry(c.runId, c.viewingKey, c.seats[0]!.signerId, material);
    await until(() => check.asked());
    expect(c.accounts.payrollRoundsOf(c.account, c.viewingKey).filter((r) => r.retry !== undefined)).toEqual([]);
    /* RED WHEN: the leg is released while a retry on it is on its way - its material is replaced and both reach the chain. */
    await expect(c.raiseOnDevice()).rejects.toThrow(/is being raised right now by another request.*Nothing was raised/su);
    check.open();
    const retry = await retrying;
    expect(retry.raisedAt).toBeDefined();
    expect(c.payroll.requireRun(c.runId, c.viewingKey).payout!.GBP!.retries!.map((r) => r.proposalId)).toEqual([retry.id]);
    await expect(c.raiseOnDevice()).rejects.toThrow(/a retry on it is still live/u);
  });

  it('IS NOT RAISED AGAIN WHILE AN APPROVED RETRY ON IT CAN STILL PAY', async () => {
    const c = await aCompany({ threshold: 1 });
    const first = await c.aRoundOnChain();
    await c.accounts.cancel(first.id, c.viewingKey);
    const rebuild = (await c.payroll.payoutRebuildOf(c.runId, c.viewingKey))!;
    const material = await retryMaterialFor({
      rebuild, indices: [0, 1], opensAt: c.window.opensAt, closesAt: c.window.closesAt, vault: c.VAULT,
      detailsOf: vaultDetails,
    });
    const retry = await c.payroll.proposeRetry(c.runId, c.viewingKey, c.seats[0]!.signerId, material);
    const s = c.seats[0]!;
    expect((await c.accounts.approve(retry.id, s.signerId, sign(approvalMessage(retry), s.signingSecret), c.viewingKey)).status)
      .toBe('approved');
    /* RED WHEN: only an open retry is counted - an approved one, the one that can pay, then lets the leg be raised over it. */
    await expect(c.raiseOnDevice()).rejects.toThrow(/a retry on it is still live/u);
  });

  it('IS NOT RAISED AGAIN WHILE A RETRY ON IT CAN STILL PAY SOME OF ITS PEOPLE, AND IS ONCE THAT RETRY IS WITHDRAWN', async () => {
    const c = await aCompany({ threshold: 1 });
    const first = await c.aRoundOnChain();
    await c.accounts.cancel(first.id, c.viewingKey);
    const rebuild = (await c.payroll.payoutRebuildOf(c.runId, c.viewingKey))!;
    const material = await retryMaterialFor({
      rebuild, indices: [0], opensAt: c.window.opensAt, closesAt: c.window.closesAt, vault: c.VAULT,
      detailsOf: vaultDetails,
    });
    const retry = await c.payroll.proposeRetry(c.runId, c.viewingKey, c.seats[0]!.signerId, material);
    expect(retry.status).toBe('open');
    /* RED WHEN: a withdrawn leg is released while a retry over some of its people is live - they could be paid by both. */
    await expect(c.raiseOnDevice()).rejects.toThrow(/a retry on it is still live/u);
    await c.accounts.cancel(retry.id, c.viewingKey);
    const again = await c.raiseOnDevice();
    expect(c.payroll.requireRun(c.runId, c.viewingKey).proposalIds.GBP).toBe(again.id);
  });
});

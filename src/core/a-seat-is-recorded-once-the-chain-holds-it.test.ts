/**
 * **A SEAT OR A THRESHOLD CHANGE A SIGNER'S DEVICE SENDS IS WRITTEN ON THE
 * COMPANY'S RECORD ONLY ONCE THE CHAIN SHOWS IT.** The door a device's
 * transaction goes through can tell which circuit it calls and not which leaf
 * it seats, so the record asks the chain. Driven through the account service
 * with the simulated ledger under it and a door that lands a device's call only
 * when the test says so; the wait between reads is shortened.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedLedger } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { FileStore } from './store-file.js';
import { AccountService } from './account.js';
import { NO_ASSET } from './assets.js';
import { newBlinding, newSigningKeypair, newWrappingKeypair, type Hex } from './crypto.js';
import { storedSignerLeaf } from './signer-leaf.js';
import { NothingWasSent } from './jobs.js';

type Held = { circuit: string; land: () => Promise<unknown> };
let ledger: SimulatedLedger;
let accounts: AccountService;
let company: string;
let viewingKey: Hex;
let ada: { signerId: string; leaf: Hex };
let bo: { signerId: string; leaf: Hex };
let held: Held[];
let landAtOnce: boolean;

beforeEach(async () => {
  ledger = new SimulatedLedger(MidnightCommitments);
  held = [];
  landAtOnce = true;
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-seat-seen-')), 'db.json'));
  accounts = new AccountService(store, ledger, MidnightCommitments, undefined, undefined, { everyMs: 1, attempts: 3 });
  const created = await accounts.create('Seen', [{ name: 'Ada', role: 'admin', userId: 'usr_ada' }], 1);
  company = created.account.id;
  viewingKey = created.viewingKey;
  ada = { signerId: created.secrets[0]!.signerId, leaf: created.account.signers[0]!.leafCommitment as Hex };
  const pair = newSigningKeypair();
  const leaf = storedSignerLeaf({ signingSecret: pair.secret, blinding: newBlinding(), scope: MidnightCommitments.allVaults() }, MidnightCommitments);
  const raw = accounts.inviteSigner(company, 'Bo', 'bo@example.test', 'approver');
  bo = { signerId: accounts.acceptSignerInvite(raw.token, 'usr_bo', pair.publicKey, newWrappingKeypair().publicKey, leaf).id, leaf };
  /* A device's call, as the door hands it to the chain: here the test's own record of what to do, and when. */
  Object.assign(ledger, {
    submitProvenCall: async (accountId: string, bytes: Uint8Array, circuit: string) => {
      const call = JSON.parse(Buffer.from(bytes).toString('utf8')) as { do: string; leaf?: Hex; proposal: Hex; threshold?: number };
      const by = { signerId: ada.signerId, leaf: ada.leaf };
      const land = () => (call.do === 'seat'
        ? ledger.addSigner(accountId, call.leaf!, call.proposal, by)
        : ledger.setThreshold(accountId, call.threshold!, call.proposal, by));
      if (landAtOnce) await land(); else held.push({ circuit, land });
      return { ref: 'tx', at: new Date().toISOString() };
    },
  });
});

/** A seat proposal written down and approved on the simulated chain, as devices would have left it. */
const approvedSeat = async () => {
  const p = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId);
  const change = { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: accounts.seatOrderOf(company, viewingKey, bo.signerId).proposalSalt };
  await ledger.propose(company, MidnightCommitments.signerAddPayload(bo.leaf), change, ada, MidnightCommitments.noVault());
  await ledger.approve(company, p.chainId as Hex, ada);
  return p;
};
const seatTx = (p: { chainId: string }, leaf: Hex) =>
  new Uint8Array(Buffer.from(JSON.stringify({ do: 'seat', leaf, proposal: p.chainId })));
const statusOf = (signerId: string) => accounts.open(company, viewingKey).signers.find((s) => s.id === signerId)!.status;

describe('A SEAT IS WRITTEN ON THE RECORD ONLY ONCE THE CHAIN HOLDS IT', () => {
  it('a seat the chain made at once is recorded, and the proposal that made it is closed on the record', async () => {
    const p = await approvedSeat();
    await accounts.seatFromDevice(company, viewingKey, bo.signerId, seatTx(p, bo.leaf), ada.signerId);
    expect(statusOf(bo.signerId)).toBe('active');
    /* RED WHEN: the proposal is left approved, and asking for the same change again hands back one the chain closed. */
    expect(accounts.requireProposal(p.id, viewingKey).status).toBe('executed');
  });

  it('A SEAT THE CHAIN HAS NOT SHOWN IS NOT RECORDED, AND IS RECORDED THE NEXT TIME ANYBODY ASKS ONCE IT HAS', async () => {
    const p = await approvedSeat();
    landAtOnce = false;
    const r = await accounts.seatFromDevice(company, viewingKey, bo.signerId, seatTx(p, bo.leaf), ada.signerId).catch((e) => e);
    /* RED WHEN: the person is admitted when the transaction is handed over rather than when the chain holds their seat. */
    expect(r).toBeInstanceOf(Error);
    expect(r).not.toBeInstanceOf(NothingWasSent);
    expect(r.message).toMatch(/sent and the chain has not shown it yet/u);
    expect(statusOf(bo.signerId)).toBe('pending');
    await held.shift()!.land();
    const again = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId);
    expect(again.status).toBe('executed');
    expect(statusOf(bo.signerId)).toBe('active');
  });

  it('A TRANSACTION THAT SEATS SOMEBODY ELSE DOES NOT ADMIT THE PERSON NAMED', async () => {
    const p = await approvedSeat();
    /* Any seating call gets past the door; this one seats a leaf nobody approved, and the chain refuses it. */
    await expect(accounts.seatFromDevice(company, viewingKey, bo.signerId, seatTx(p, 'ee'.repeat(32) as Hex), ada.signerId))
      .rejects.toThrow();
    /* RED WHEN: the record admits whoever the route names, whatever the transaction did. */
    expect(statusOf(bo.signerId)).toBe('pending');
    expect(accounts.open(company, viewingKey).wrappedKeys.some((w) => w.signerId === bo.signerId)).toBe(false);
  });

  it('a refusal before anything is sent is marked as sending nothing', async () => {
    /* No approved proposal for this seat yet. */
    await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId);
    const r = await accounts.seatFromDevice(company, viewingKey, bo.signerId, seatTx({ chainId: '00'.repeat(32) }, bo.leaf), 'sgn_nobody')
      .catch((e) => e);
    expect(r).toBeInstanceOf(NothingWasSent);
  });
});

describe('WHAT A DEVICE IS HANDED FOR A SEAT OR A THRESHOLD IS REFUSED TO A WRONG VIEWING KEY', () => {
  it('the order, the salt and what the proposal changes each need the company\'s viewing key', async () => {
    const p = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId);
    const wrong = '11'.repeat(32) as Hex;
    /* RED WHEN: any of them answers without opening the sealed record with the key presented. */
    expect(() => accounts.seatOrderOf(company, wrong, bo.signerId)).toThrow();
    expect(() => accounts.thresholdOrderOf(company, wrong, 1)).toThrow();
    expect(() => accounts.governanceAsked(p.id, wrong)).toThrow();
    await expect(accounts.governanceOrderOf(p.id, wrong)).rejects.toThrow();
  });
});

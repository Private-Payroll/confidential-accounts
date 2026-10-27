/**
 * **A SEAT IS WRITTEN ON THE COMPANY'S RECORD ONLY ONCE THE CHAIN HOLDS IT.**
 * The invitee takes the seat an approved invitation names from their own
 * wallet; nothing the service or a signer's device sends can seat anybody. So
 * the record asks the chain whether it holds the person's leaf, and admits
 * them only then. Driven through the account service with the simulated ledger
 * under it, the invitee taking the seat when the test says so.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { drawCompanyLabel } from 'midnight-identity/profile/company-label';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedLedger } from './ledger.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { FileStore } from './store-file.js';
import { AccountService } from './account.js';
import { canonical, newSigningKeypair, newWrappingKeypair, seal, type Hex } from './crypto.js';
import { NothingWasSent } from './jobs.js';
import { NO_ASSET } from './assets.js';
import { newSeatInvitation, proveSeatKeys } from './seat-invite-proof.js';
import { anInvitee, theInviteeTakesTheSeat, type Invitee } from '../testing/an-invitee.js';

/** What the invited person's device sends beside its keys: the proof its link let it make. */
const provenBy = (
  viewingKey: string, invite: { accountId: string; name?: string; role?: string },
  signingPublicKey: string, wrappingPublicKey: string, leafCommitment: string,
) => proveSeatKeys(newSeatInvitation(viewingKey, invite.accountId, invite.name!, invite.role!),
  { signingPublicKey, wrappingPublicKey, leafCommitment });

let ledger: SimulatedLedger;
let accounts: AccountService;
let company: string;
let viewingKey: Hex;
let ada: { signerId: string; leaf: Hex };
let bo: { signerId: string; at: Invitee };

beforeEach(async () => {
  ledger = new SimulatedLedger(MidnightCommitments);
  const store = new FileStore(join(mkdtempSync(join(tmpdir(), 'mn-seat-seen-')), 'db.json'));
  accounts = new AccountService(store, ledger, MidnightCommitments, undefined, undefined, undefined, { everyMs: 1, attempts: 3 });
  const created = await accounts.create('Seen', [{ name: 'Ada', role: 'admin', userId: 'usr_ada' }], 1, undefined, drawCompanyLabel());
  company = created.account.id;
  viewingKey = created.viewingKey;
  ada = { signerId: created.secrets[0]!.signerId, leaf: created.account.signers[0]!.leafCommitment as Hex };
  const at = anInvitee(MidnightCommitments, 31);
  const pair = newSigningKeypair();
  const raw = accounts.inviteSigner(company, 'Bo', 'bo@example.test', 'approver');
  const boWrapping = newWrappingKeypair().publicKey;
  bo = { signerId: accounts.acceptSignerInvite(raw.token, 'usr_bo', pair.publicKey, boWrapping, at.leaf,
    provenBy(viewingKey, raw, pair.publicKey, boWrapping, at.leaf)).id, at };
});

/**
 * An invitation written down for a device to raise, raised on the simulated chain as Ada's device would: at a
 * threshold of one the raise is its raiser's approval.
 */
const raisedOnTheChain = async (p: { id: string }, at: Invitee = bo.at) => {
  const { proposalSalt } = accounts.governanceAsked(p.id, viewingKey);
  const change = { asset: NO_ASSET, amount: 0n, batchDigest: '00'.repeat(32) as Hex, salt: proposalSalt };
  await ledger.propose(company, MidnightCommitments.signerInvitePayload(at.address, at.scope), change, ada, MidnightCommitments.noVault());
};
const statusOf = (signerId: string) => accounts.open(company, viewingKey).signers.find((s) => s.id === signerId)!.status;

describe('A SEAT IS WRITTEN ON THE RECORD ONLY ONCE THE CHAIN HOLDS IT', () => {
  it('a seat the invitee took is recorded the next time anybody asks, and the invitation that made it is closed on the record', async () => {
    /* At a threshold of one the raise is its raiser's approval. */
    const p = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId, bo.at.invite);
    await raisedOnTheChain(p);
    await theInviteeTakesTheSeat(ledger, company, bo.at, p.chainId as Hex);
    const again = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId, bo.at.invite);
    expect(again.id).toBe(p.id);
    /* RED WHEN: the invitation is left approved, and asking for the same seat again hands back one the chain closed. */
    expect(again.status).toBe('executed');
    expect(statusOf(bo.signerId)).toBe('active');
  });

  it('A SEAT THE CHAIN DOES NOT HOLD IS NOT RECORDED: ASKING AGAIN HANDS BACK THE SAME INVITATION, NOT A SECOND ONE', async () => {
    const p = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId, bo.at.invite);
    const again = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId, bo.at.invite);
    expect(again.id).toBe(p.id);
    /* RED WHEN: the person is admitted before the chain holds their seat. */
    expect(statusOf(bo.signerId)).toBe('pending');
    await expect(accounts.grantAccess(company, viewingKey, bo.signerId)).rejects.toThrow(/has not taken their seat on the chain yet/u);
  });

  it('A WALLET THE INVITATION DOES NOT NAME CANNOT TAKE THE SEAT, AND THE PERSON NAMED IS NOT ADMITTED', async () => {
    const p = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId, bo.at.invite);
    await raisedOnTheChain(p);
    await expect(theInviteeTakesTheSeat(ledger, company, anInvitee(MidnightCommitments, 32), p.chainId as Hex))
      .rejects.toThrow(/does not invite this wallet/u);
    /* RED WHEN: the record admits whoever the route names, whatever the chain holds. */
    expect(statusOf(bo.signerId)).toBe('pending');
    expect(accounts.open(company, viewingKey).wrappedKeys.some((w) => w.signerId === bo.signerId)).toBe(false);
  });

  it('a seat the chain already holds with no invitation written down is recorded, and says nothing was sent', async () => {
    const p = await accounts.proposeSigner(company, viewingKey, bo.signerId, ada.signerId, bo.at.invite);
    await theInviteeTakesTheSeat(ledger, company, bo.at, p.chainId as Hex);
    /* Asked for another invitation to a different address: the chain already holds Bo's seat, so none is raised. */
    const r = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId, anInvitee(MidnightCommitments, 33).invite)
      .catch((e) => e);
    expect(r).toBeInstanceOf(NothingWasSent);
    expect(statusOf(bo.signerId)).toBe('active');
  });
});

describe('WHAT A DEVICE IS HANDED FOR AN INVITATION OR A THRESHOLD IS REFUSED TO A WRONG VIEWING KEY', () => {
  it('the salt and what the proposal changes each need the company\'s viewing key', async () => {
    const p = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId, bo.at.invite);
    const wrong = '11'.repeat(32) as Hex;
    /* RED WHEN: any of them answers without opening the sealed record with the key presented. */
    expect(() => accounts.thresholdOrderOf(company, wrong, 1)).toThrow();
    expect(() => accounts.governanceAsked(p.id, wrong)).toThrow();
    await expect(accounts.governanceOrderOf(p.id, wrong)).rejects.toThrow();
    /* And with the right key, the invitation is what the proposal names. */
    expect(accounts.governanceAsked(p.id, viewingKey).governance)
      .toEqual({ kind: 'add-signer', address: bo.at.address, scope: bo.at.scope });
  });
});

describe('A DEVICE IS HANDED THE PROPOSAL WRITTEN DOWN WITH ITS SALT, NEVER AN APPROVED ONE WRITTEN WITHOUT', () => {
  it('an approved invitation with no salt does not win over the live one a device can act on', async () => {
    /* A proposal written down before proposals carried a salt, and approved: its payload names the change and no salt. */
    const legacy = await accounts.proposeSigner(company, viewingKey, bo.signerId, ada.signerId, bo.at.invite);
    const opened = accounts.requireProposal(legacy.id, viewingKey);
    (accounts as unknown as { putProposal(p: unknown, vk: Hex): void }).putProposal(
      { ...opened, status: 'approved', sealedPayload: seal(canonical({ signerId: bo.signerId, entries: [] }), viewingKey) }, viewingKey);
    const live = await accounts.seatRound(company, viewingKey, bo.signerId, ada.signerId, bo.at.invite);
    /* RED WHEN: the invitation is taken from whichever proposal sorts first - the approved one without a salt. */
    expect(live.id).not.toBe(legacy.id);
    expect(accounts.governanceAsked(live.id, viewingKey).proposalSalt).toMatch(/^[0-9a-f]{64}$/u);
  });
});

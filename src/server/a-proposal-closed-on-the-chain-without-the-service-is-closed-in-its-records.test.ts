/**
 * **A PROPOSAL CARRIED OUT OR WITHDRAWN BY A CALL A SIGNER'S WALLET SENT STRAIGHT TO THE CHAIN IS CLOSED IN THE
 * SERVICE'S RECORD, AS THE SERVICE'S OWN READ OF THE ACCOUNT'S HISTORY SHOWS IT CLOSED, OVER REAL HTTP.**
 *
 * The proposal routes are mounted beside one company of two seats (`a-company-of-two-seats`): Ada holds a seat,
 * Eve the only seat of another company. The ledger is a stand-in whose read of the account answers the proposals it
 * holds open; the account's history is a stand-in that says how the chain closed each proposal. Nothing here sends a
 * call, so the ledger's door for a proven call refuses every one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { aCompanyOfTwoSeats, store, CO, ADA, EVE, sendAs } from './a-company-of-two-seats.test-support.js';
import { proposalRelayRoutes } from './proposal-relays.js';
import type { ClosedOnChain } from './proposal-closed-on-chain.js';
import type { LedgerStatus } from '../core/ledger.js';
import type { SealedProposal } from '../core/types.js';
import type { Hex } from '../core/crypto.js';
import { MidnightCommitments } from '../midnight/commitments.js';

const open = new Map<string, number>();
let history: ClosedOnChain = 'carried';
let callsSent = 0;

const ledger = {
  wiring: 'simulated' as const,
  status: async (): Promise<LedgerStatus | null> => ({
    assets: [], openProposals: [...open].map(([id, approvals]) => ({ id: id as Hex, change: '00'.repeat(32) as Hex, approvals })),
    threshold: 2, vaultThresholds: [], signerCount: 2,
  } as unknown as LedgerStatus),
  submitProvenCall: async () => { callsSent += 1; throw new Error('closing a record sends no call'); },
};

aCompanyOfTwoSeats((app, deps) => {
  const ownsProposal: express.RequestHandler = (req, res, next) => {
    const p = store.getProposal(String(req.params.id));
    return p !== null && store.getAccount(p.accountId)?.memberUserIds.includes(req.userId!) ? next() : res.status(404).json({ error: 'not found' });
  };
  app.use(proposalRelayRoutes({
    signedIn: deps.signedIn, member: deps.member, ownsProposal, refuseSigningSecret: (_req, _res, next) => next(),
    store, ledger, directoryOf: deps.directoryOf, recordRefusal: () => undefined,
    proposalIdOf: (h, salt, vault) => MidnightCommitments.proposalId(h as Hex, salt as Hex, vault as Hex | undefined),
    closedOnChain: async (_accountId, chainId) => (open.has(chainId) ? 'open' : history),
  }));
});

const P = 'prp_closedAAAAAAA';
const CHAIN = '23'.repeat(32);
const proposal = (over: Partial<SealedProposal> = {}): SealedProposal => ({
  id: P, accountId: CO, status: 'open', createdAt: '2026-10-07T00:00:00.000Z', digest: '11'.repeat(32) as Hex,
  chainId: CHAIN as Hex, approvalCount: 1, keyEpoch: 0, sealed: { iv: '', tag: '', body: '' } as never,
  raisedAt: '2026-10-07T00:01:00.000Z', ...over,
});

beforeEach(() => {
  open.clear(); history = 'carried'; callsSent = 0;
  store.putProposal(proposal());
});

const closed = (who: string, how?: string, filer = who === 'ada' ? ADA.statement.signingKey : EVE.statement.signingKey) =>
  sendAs(who)(`/api/proposals/${P}/closed`, { method: 'POST', body: JSON.stringify({ filer, ...(how === undefined ? {} : { how }) }) }) as Promise<{ status: number; body: any }>;

describe('A PROPOSAL CLOSED STRAIGHT ON THE CHAIN IS CLOSED IN THE SERVICE\'S RECORD AS THE CHAIN CLOSED IT', () => {
  it('one the account\'s history shows carried out is marked carried out, whatever the request names, and no call is sent', async () => {
    const r = await closed('ada');
    /* RED WHEN: a proposal carried out by a signer's own wallet stays open in the company's records. */
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('executed');
    expect(store.getProposal(P)!.status).toBe('executed');
    expect(callsSent).toBe(0);
  });

  it('one the history shows withdrawn is marked withdrawn, never carried out on a device\'s word', async () => {
    history = 'withdrawn';
    /* RED WHEN: a request naming the wrong way closes the record that way - a withdrawn run marked carried out, or the reverse. */
    expect((await closed('ada', 'carried')).status).toBe(409);
    expect(store.getProposal(P)!.status).toBe('open');
    /* RED WHEN: a proposal withdrawn by a signer's own wallet stays open in the company's records. */
    expect((await closed('ada')).body.status).toBe('cancelled');
    expect(store.getProposal(P)!.status).toBe('cancelled');
  });

  it('one the chain still holds open, or whose closing cannot be told from the history, is answered as it stands', async () => {
    open.set(CHAIN, 1);
    /* RED WHEN: a proposal the chain still holds open is closed. */
    expect((await closed('ada', 'carried')).body.status).toBe('open');
    open.clear();
    history = 'unknown';
    /* RED WHEN: a proposal is closed when its history could not be read or does not say how it closed. */
    expect((await closed('ada', 'carried')).body.status).toBe('open');
    expect(store.getProposal(P)!.status).toBe('open');
  });

  it('one the service never saw raised is closed when the history shows it closed, and one the chain never held is not', async () => {
    store.putProposal(proposal({ raisedAt: undefined }));
    /* RED WHEN: a proposal raised and carried out straight on the chain between two reads of the service is left open for good. */
    expect((await closed('ada')).body.status).toBe('executed');
    store.putProposal(proposal({ raisedAt: undefined }));
    history = 'never';
    /* RED WHEN: a proposal only written down is marked closed because the chain does not hold it. */
    expect((await closed('ada')).status).toBe(409);
    expect(store.getProposal(P)!.status).toBe('open');
  });

  it('only a seat of the company may close it, under its own filing key, and only as carried out or withdrawn', async () => {
    /* RED WHEN: a seat of another company, or a request under a key no seat of this company holds, closes the record. */
    expect((await closed('eve')).status).not.toBe(200);
    expect((await closed('ada', undefined, 'cc'.repeat(32))).status).toBe(403);
    /* RED WHEN: a request may name a closing that is neither. */
    expect((await closed('ada', 'blocked')).status).toBe(400);
    expect(store.getProposal(P)!.status).toBe('open');
  });

  it('one already closed is answered as it stands', async () => {
    store.putProposal(proposal({ status: 'cancelled' }));
    /* RED WHEN: a withdrawn proposal is turned into a carried-out one by a later request. */
    expect((await closed('ada', 'carried')).body.status).toBe('cancelled');
  });
});

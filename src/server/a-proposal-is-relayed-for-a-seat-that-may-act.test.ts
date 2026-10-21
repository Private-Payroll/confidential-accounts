/**
 * **A PROPOSAL'S RAISE, APPROVAL, WITHDRAWAL AND CARRYING OUT ARE RELAYED WITH
 * NO KEY, ONLY FOR A SEAT THAT MAY ACT, OVER REAL HTTP.**
 *
 * The proposal routes (`proposal-relays.ts`) are mounted beside the directory
 * and records routes of one company of two seats (`a-company-of-two-seats`):
 * Ada holds a seat whose role is not named, Bo an approver's, Eve the only seat
 * of another company, and Cy is a member of Ada's company with no seat. The
 * ledger is a stand-in, and named: its door for a proven call reads which call
 * and which proposal a stand-in transaction carries and does to its open
 * proposals what that call would; its read of the account answers from them.
 *
 * Every assertion names the change that turns it red.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import { aCompanyOfTwoSeats, store, chains, CO, OTHER, ADA, BO, EVE, seatOf, sendAs } from './a-company-of-two-seats.test-support.js';
import { signingPublicKeyOf } from '../core/crypto.js';
import { proposalRelayRoutes } from './proposal-relays.js';
import { signProposalFiling, type ProposalFiling } from '../core/proposal-filing.js';
import { NothingWasSent } from '../core/jobs.js';
import { FeeNotPaid } from '../midnight/sponsor.js';
import { DEVICE_RAISE_VERSION } from '../core/device-raise.js';
import type { LedgerStatus } from '../core/ledger.js';
import type { SealedProposal } from '../core/types.js';
import type { Hex } from '../core/crypto.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { adoptionRoundOf, type AccountStartPure } from '../midnight/vault-start.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';

/* ── the chain, stood in ─────────────────────────────────────────────────── */

const open = new Map<string, number>();
/* The vaults the company's account lists on the stand-in chain: those it adopted. */
const adopted = new Set<string>();
let unreadable = false;
let refuseAtTheDoor: string | null = null;
/* A fee the fee payer could not pay, refused before anything reached the chain. */
let feeNotPaid = false;
const sent: Array<{ accountId: string; circuit: string; proposal: string }> = [];
const tx = (circuit: string, proposal: string): string => Buffer.from(JSON.stringify({ circuit, proposal })).toString('base64');

const ledger = {
  wiring: 'simulated' as const,
  status: async (): Promise<LedgerStatus | null> => (unreadable ? null : {
    assets: [], openProposals: [...open].map(([id, approvals]) => ({ id: id as Hex, change: '00'.repeat(32) as Hex, approvals })),
    threshold: 2, vaultThresholds: [], signerCount: 2,
  } as unknown as LedgerStatus),
  submitProvenCall: async (accountId: string, bytes: Uint8Array, circuit: string) => {
    const o = JSON.parse(Buffer.from(bytes).toString('utf8')) as { circuit: string; proposal: string };
    if (refuseAtTheDoor !== null) throw new NothingWasSent(refuseAtTheDoor);
    if (feeNotPaid) throw new FeeNotPaid('the fee for this call could not be paid just now. Nothing was sent.');
    if (o.circuit !== circuit) throw new NothingWasSent(`the door was told ${circuit} and handed ${o.circuit}. Nothing was sent.`);
    sent.push({ accountId, circuit, proposal: o.proposal });
    if (circuit === 'propose') open.set(o.proposal, 0);
    else if (circuit === 'approve') open.set(o.proposal, (open.get(o.proposal) ?? 0) + 1);
    /* A charge leaves the run's proposal open, to be paid; every other call closes the one it carries out. */
    else if (circuit !== 'clearRun') open.delete(o.proposal);
    return { ref: `ref-${sent.length}`, at: new Date().toISOString() };
  },
};

aCompanyOfTwoSeats((app, deps) => {
  const ownsProposal: express.RequestHandler = (req, res, next) => {
    const p = store.getProposal(String(req.params.id));
    return p !== null && store.getAccount(p.accountId)?.memberUserIds.includes(req.userId!) ? next() : res.status(404).json({ error: 'not found' });
  };
  const refuseSigningSecret: express.RequestHandler = (req, res, next) =>
    (req.body && typeof req.body === 'object' && 'signingSecret' in req.body ? res.status(400).json({ code: 'signing-secret-refused' }) : next());
  app.use(proposalRelayRoutes({
    signedIn: deps.signedIn, member: deps.member, ownsProposal, refuseSigningSecret,
    store, ledger, directoryOf: deps.directoryOf, recordRefusal: () => undefined,
    proposalIdOf: (h, salt, vault) => MidnightCommitments.proposalId(h as Hex, salt as Hex, vault as Hex | undefined),
    adoptionOf: (vault) => adoptionRoundOf(pureCircuits as unknown as AccountStartPure, vault),
    vaultsAdopted: async () => (unreadable ? null : [...adopted]),
  }));
});

beforeAll(() => {
  /* Cy is a member of Ada's company and holds no seat on it. */
  const acme = store.getAccount(CO)!;
  store.putAccount({ ...acme, memberUserIds: [...acme.memberUserIds, 'cy'] });
});

const P = 'prp_relayedAAAAA';
const CHAIN = '22'.repeat(32);
const proposal = (over: Partial<SealedProposal> = {}): SealedProposal => ({
  id: P, accountId: CO, status: 'open', createdAt: '2026-10-07T00:00:00.000Z', digest: '11'.repeat(32) as Hex,
  chainId: CHAIN as Hex, approvalCount: 0, keyEpoch: 0, sealed: { iv: '', tag: '', body: '' } as never, ...over,
});

beforeEach(() => {
  open.clear(); adopted.clear(); sent.length = 0; unreadable = false; refuseAtTheDoor = null; feeNotPaid = false;
  store.putProposal(proposal());
});

/** The filing key each person's device sends with a relay: its own seat's, or, for one with no seat here, a key no entry names. */
const FILER: Readonly<Record<string, string>> = { ada: ADA.statement.signingKey, bo: BO.statement.signingKey, eve: EVE.statement.signingKey };
const RELAYS = /\/(approve|cancel|send|carry|charge|retirement|carried)$/u;
/** A request as the person's device sends it: a relay carries the device's filing key unless the body names its own. */
const post = (who: string | null, path: string, body: unknown) => {
  const carried = RELAYS.test(path) && typeof body === 'object' && body !== null && !('filer' in body)
    ? { filer: FILER[who ?? ''] ?? 'cc'.repeat(32), ...body } : body;
  return sendAs(who)(path, { method: 'POST', body: JSON.stringify(carried) }) as Promise<{ status: number; body: any }>;
};

describe('A PROPOSAL IS RELAYED WITH NO KEY, FOR A SEAT THAT MAY ACT', () => {
  it('AN APPROVAL A SEAT\'S DEVICE PROVED IS RELAYED AS AN APPROVAL, AND THE CHAIN\'S COUNT IS WRITTEN DOWN', async () => {
    open.set(CHAIN, 0);
    const r = await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN) });
    /* RED WHEN the route relays nothing, or relays it as another call. */
    expect(r.status).toBe(200);
    expect(sent).toEqual([{ accountId: CO, circuit: 'approve', proposal: CHAIN }]);
    /* RED WHEN the count is not read back off the chain after the send, or the proposal is not marked seen. */
    expect(r.body).toMatchObject({ id: P, chainId: CHAIN, approvalCount: 1, status: 'open' });
    expect(typeof r.body.raisedAt).toBe('string');
    expect(store.getProposal(P)!.approvalCount).toBe(1);
  });

  it('AN APPROVAL WHOSE FEE COULD NOT BE PAID IS REFUSED AS NOTHING SENT, WITH THE CODE A PAGE SAYS IT BY', async () => {
    open.set(CHAIN, 0);
    feeNotPaid = true;
    const r = await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN) });
    /* RED WHEN: a fee that could not be paid reaches the page with no code, so it can only say the step did not finish. */
    expect(r).toMatchObject({ status: 422, body: { nothingWasSent: true, code: 'fee-not-paid' } });
    feeNotPaid = false;
    refuseAtTheDoor = 'the chain refused it. Nothing was sent.';
    /* RED WHEN: a refusal that is not about the fee is given the fee's code. */
    expect((await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN) })).body.code).toBeUndefined();
  });

  it('NO ROUTE TAKES A KEY: A BODY THAT CARRIES ONE IS REFUSED, AND NOTHING IS SENT', async () => {
    open.set(CHAIN, 0);
    const key = 'ab'.repeat(32);
    /* RED WHEN a route's schema stops being strict, so a viewing key is carried past it. */
    for (const [path, body] of [
      [`/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN), viewingKey: key }],
      [`/api/proposals/${P}/standing`, { viewingKey: key }],
      [`/api/proposals/${P}/cancel`, { viewingKey: key }],
      [`/api/proposals/${P}/send`, { tx: tx('propose', CHAIN), version: DEVICE_RAISE_VERSION, viewingKey: key }],
      [`/api/proposals/${P}/carry`, { tx: tx('setThreshold', CHAIN), circuit: 'setThreshold', viewingKey: key }],
      [`/api/proposals/${P}/charge`, { tx: tx('clearRun', CHAIN), viewingKey: key }],
    ] as const) {
      const r = await post('ada', path, body);
      expect(r.status, path).toBe(400);
      expect(r.body.nothingWasSent, path).toBe(true);
      /* Refused as a field the route does not take, with no code: so the named refusal below is the rule, not the strictness. */
      expect(r.body.code, path).toBeUndefined();
    }
    /* RED WHEN the named refusal of a signing secret is taken off the approval route. */
    expect((await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN), signingSecret: key })).body.code).toBe('signing-secret-refused');
    expect(sent).toEqual([]);
  });

  it('ONLY A MEMBER OF THE PROPOSAL\'S COMPANY REACHES ANY OF ITS ROUTES (ownsProposal), AND ONLY ITS SEATS ARE RELAYED FOR', async () => {
    open.set(CHAIN, 0);
    const calls = [
      [`/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN) }],
      [`/api/proposals/${P}/standing`, {}],
      [`/api/proposals/${P}/cancel`, { tx: tx('cancel', CHAIN) }],
      [`/api/proposals/${P}/send`, { tx: tx('propose', CHAIN), version: DEVICE_RAISE_VERSION }],
      [`/api/proposals/${P}/carry`, { tx: tx('setThreshold', CHAIN), circuit: 'setThreshold' }],
      [`/api/proposals/${P}/charge`, { tx: tx('clearRun', CHAIN) }],
    ] as const;
    for (const [path, body] of calls) {
      /* RED WHEN ownsProposal is taken off the route: another company's seat would be relayed for. */
      expect((await post('eve', path, body)).status, path).toBe(404);
      expect((await post(null, path, body)).status, path).toBe(401);
    }
    /* The gate lets a member through: the same member's company's proposal answers. */
    expect((await post('cy', `/api/proposals/${P}/standing`, {})).status).toBe(200);
    for (const [path, body] of calls.filter(([p]) => !p.endsWith('/standing'))) {
      /* RED WHEN the directory seat is not asked: a member with no seat would be relayed for. */
      const r = await post('cy', path, body);
      expect(r.status, path).toBe(422);
      expect(r.body).toMatchObject({ nothingWasSent: true });
      expect(r.body.error, path).toMatch(/you hold no seat on this company/u);
    }
    expect(sent).toEqual([]);
    /* And the other way: another company's member cannot reach Ada's company's proposal list to write one down. */
    expect((await post('eve', `/api/accounts/${CO}/proposals`, { proposal: {} })).status).toBe(404);
    expect((await post('ada', `/api/accounts/${OTHER}/proposals`, { proposal: {} })).status).toBe(404);
  });

  it('A PROPOSAL WITHDRAWN, CARRIED OUT OR STOPPED TAKES NO APPROVAL, AND NOTHING IS SENT', async () => {
    open.set(CHAIN, 0);
    for (const status of ['cancelled', 'executed', 'blocked'] as const) {
      store.putProposal(proposal({ status }));
      /* RED WHEN the route stops reading the plain status before it relays. */
      const r = await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN) });
      expect(r.status, status).toBe(422);
    }
    expect(sent).toEqual([]);
  });

  it('WHERE A PROPOSAL STANDS IS THE CHAIN\'S, AND A COUNT ALREADY WRITTEN IS NEVER LOWERED', async () => {
    open.set(CHAIN, 2);
    expect((await post('ada', `/api/proposals/${P}/standing`, {})).body).toMatchObject({ approvalCount: 2 });
    open.set(CHAIN, 1);
    /* RED WHEN a later, lower read writes the count backwards. */
    expect((await post('ada', `/api/proposals/${P}/standing`, {})).body).toMatchObject({ approvalCount: 2 });
    unreadable = true;
    /* RED WHEN a chain that did not answer is read as a count of nothing. */
    expect((await post('ada', `/api/proposals/${P}/standing`, {})).body).toMatchObject({ approvalCount: 2 });
  });

  it('A RAISE IS SENT ONLY FROM A PAGE OF THIS VERSION, ONLY WHILE THE CHAIN DOES NOT HOLD IT, AND ITS REFERENCE IS WRITTEN DOWN', async () => {
    /* RED WHEN the version is not asked. */
    expect((await post('ada', `/api/proposals/${P}/send`, { tx: tx('propose', CHAIN) })).status).toBe(422);
    const r = await post('bo', `/api/proposals/${P}/send`, { tx: tx('propose', CHAIN), version: DEVICE_RAISE_VERSION });
    expect(r.status).toBe(200);
    expect(sent.map((x) => x.circuit)).toEqual(['propose']);
    /* RED WHEN the reference is not written down, or the proposal is not marked seen. */
    expect(store.getProposal(P)).toMatchObject({ txRef: 'ref-1' });
    expect(typeof store.getProposal(P)!.raisedAt).toBe('string');
    /* RED WHEN a proposal the chain holds is sent again. */
    const again = await post('ada', `/api/proposals/${P}/send`, { tx: tx('propose', CHAIN), version: DEVICE_RAISE_VERSION });
    expect(again.status).toBe(422);
    expect(again.body.error).toMatch(/already holds this proposal/u);
    expect(sent).toHaveLength(1);
  });

  it('A WITHDRAWAL: NO CALL FOR ONE ONLY WRITTEN DOWN, THE DEVICE\'S CALL FOR ONE ON THE CHAIN, AND NONE FOR ONE SENT AND NOT YET SEEN', async () => {
    /* Only written down: withdrawn here with no call. RED WHEN a call is demanded for it, or one is sent. */
    let r = await post('ada', `/api/proposals/${P}/cancel`, {});
    expect(r.body).toMatchObject({ status: 'cancelled' });
    expect(sent).toEqual([]);
    /* Sent, and not seen yet: it may still land. RED WHEN it is closed here. */
    store.putProposal(proposal({ txRef: 'ref-x' }));
    r = await post('ada', `/api/proposals/${P}/cancel`, {});
    expect(r.status).toBe(422);
    expect(store.getProposal(P)!.status).toBe('open');
    /* On the chain: withdrawn only by the call a device proved. RED WHEN it is closed here with none. */
    open.set(CHAIN, 1);
    store.putProposal(proposal());
    r = await post('ada', `/api/proposals/${P}/cancel`, {});
    expect(r.status).toBe(422);
    expect(store.getProposal(P)!.status).toBe('open');
    r = await post('ada', `/api/proposals/${P}/cancel`, { tx: tx('cancel', CHAIN) });
    expect(sent.map((x) => x.circuit)).toEqual(['cancel']);
    /* RED WHEN it is written down withdrawn while the chain still holds it, or not once it no longer does. */
    expect(r.body).toMatchObject({ status: 'cancelled' });
    /* A ledger that does not answer withdraws nothing. */
    store.putProposal(proposal());
    unreadable = true;
    expect((await post('ada', `/api/proposals/${P}/cancel`, {})).status).toBe(422);
    expect(store.getProposal(P)!.status).toBe('open');
  });

  it('A GOVERNANCE CHANGE CARRIED OUT IS WRITTEN DOWN AS CARRIED OUT ONLY ONCE THE CHAIN CLOSED IT', async () => {
    /* Not on the chain: nothing to carry out. */
    expect((await post('ada', `/api/proposals/${P}/carry`, { tx: tx('setThreshold', CHAIN), circuit: 'setThreshold' })).status).toBe(422);
    open.set(CHAIN, 2);
    const r = await post('bo', `/api/proposals/${P}/carry`, { tx: tx('setThreshold', CHAIN), circuit: 'setThreshold' });
    /* RED WHEN the circuit named is not the one relayed, or the proposal is not closed once the chain closed it. */
    expect(sent).toEqual([{ accountId: CO, circuit: 'setThreshold', proposal: CHAIN }]);
    expect(r.body).toMatchObject({ status: 'executed' });
    /* RED WHEN a circuit the route does not carry is relayed. */
    expect((await post('ada', `/api/proposals/${P}/carry`, { tx: tx('approve', CHAIN), circuit: 'approve' })).status).toBe(400);
  });

  describe('A VAULT\'S ADOPTION THE CHAIN CARRIED OUT IS WRITTEN DOWN AS CARRIED OUT, AND NOTHING ELSE IS', () => {
    const V = 'ab'.repeat(32) as Hex;
    const A = 'prp_adoptionAAAA';
    const round = adoptionRoundOf(pureCircuits as unknown as AccountStartPure, V);
    const raisedAt = '2026-10-20T18:03:50.963Z';
    const adoption = (over: Partial<SealedProposal> = {}) => proposal({ id: A, chainId: round.proposal, digest: round.payload, raisedAt, ...over });
    const carried = (who: string, id = A, body: Record<string, unknown> = { vault: V }) => post(who, `/api/proposals/${id}/carried`, body);

    it('writes it down once the chain no longer holds it open and shows the vault adopted by the company\'s account, sending nothing', async () => {
      store.putProposal(adoption());
      open.set(round.proposal, 1);
      adopted.add(V);
      /* RED WHEN: an adoption the chain still holds open is written down as carried out - its approvals would be refused. */
      const stillOpen = await carried('ada');
      expect(stillOpen.status).toBe(409);
      expect(stillOpen.body.error).toMatch(/still shows this adoption open, so it does not mark it done yet\. The vault is not affected\. Press again in a minute$/u);
      open.delete(round.proposal);
      adopted.clear();
      /* RED WHEN: an adoption closed on the chain without the vault adopted - withdrawn - is written down as carried out. */
      const notAdopted = await carried('ada');
      expect(notAdopted.body.error).toMatch(/does not show this vault adopted yet/u);
      /*
       * RED WHEN: a refusal the page says after "the adoption is carried out on the chain" tells the person to approve,
       * raise or withdraw it again, or to change the service; or does not say the vault is not affected and nothing was sent.
       */
      expect(notAdopted.body).toMatchObject({ nothingWasSent: true });
      expect(notAdopted.body.error).toMatch(/The vault is not affected\. Press again in a minute$/u);
      expect(notAdopted.body.error).not.toMatch(/withdrawn|Approve|raise|turns that read on/u);
      expect(store.getProposal(A)!.status).toBe('open');
      adopted.add(V);
      unreadable = true;
      /* RED WHEN: a chain that did not answer is read as one that closed it. */
      expect((await carried('ada')).status).toBe(503);
      unreadable = false;
      /* RED WHEN: the vault's adoption, carried out on the chain, stays open with no approvals on every screen. */
      expect((await carried('ada')).body).toMatchObject({ status: 'executed' });
      expect(sent).toEqual([]);
    });

    it('refuses a run that closed unpaid, any proposal that is not that vault\'s adoption, and one withdrawn', async () => {
      adopted.add(V);
      /* A run raised, approved and never paid, closed on the chain once its window passed: no longer open there. */
      store.putProposal(proposal({ raisedAt, approvalCount: 2 }));
      /* RED WHEN: a run the chain closed unpaid is written down as carried out, and every screen shows it paid. */
      expect((await carried('ada', P)).body.error).toMatch(/not the adoption of that vault/u);
      expect(store.getProposal(P)!.status).toBe('open');
      /* RED WHEN: a proposal is taken for an adoption because the vault named is adopted, whatever the proposal is. */
      store.putProposal(adoption({ digest: '33'.repeat(32) as Hex }));
      expect((await carried('ada')).status).toBe(409);
      /* RED WHEN: an adoption is written down for a vault it is not the adoption of. */
      store.putProposal(adoption());
      adopted.add('cd'.repeat(32));
      expect((await carried('ada', A, { vault: 'cd'.repeat(32) })).status).toBe(409);
      /* RED WHEN: a proposal withdrawn is written down again as carried out. */
      store.putProposal(adoption({ status: 'cancelled' }));
      expect((await carried('ada')).status).toBe(409);
      expect(store.getProposal(A)!.status).toBe('cancelled');
      /* RED WHEN: a proposal the chain never showed raised is written down as carried out. */
      store.putProposal(adoption({ raisedAt: undefined }));
      expect((await carried('ada')).status).toBe(409);
    });

    it('is asked only from a seat that may act, of a company the person is a member of', async () => {
      store.putProposal(adoption());
      adopted.add(V);
      /* RED WHEN: a member who holds no seat writes a proposal down as carried out. */
      expect((await carried('cy')).status).toBe(403);
      expect(store.getProposal(A)!.status).toBe('open');
      /* RED WHEN: a person not a member of the company reaches it. */
      expect((await carried('eve')).status).toBe(404);
      /* RED WHEN: a request that names no vault is taken. */
      expect((await carried('ada', A, {})).status).toBe(400);
      expect((await carried('ada')).body).toMatchObject({ status: 'executed' });
    });
  });

  it('A RETIREMENT SIGNATURE IS KEPT BESIDE ITS PROPOSAL AS THE SEAT HANDED IT IN, WITH ITS APPROVAL OR SIGNED AGAIN, AND SERVED UNJUDGED', async () => {
    open.set(CHAIN, 0);
    const adas = { signedFor: 4, publicKey: FILER.ada, signature: 'a1'.repeat(64) };
    expect((await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN), retirement: adas })).status).toBe(200);
    /* RED WHEN: a retirement signature an approval carries is not kept beside its proposal. */
    expect(store.getProposal(P)!.retirementSignatures).toEqual([adas]);
    const bos = { signedFor: 5, publicKey: FILER.bo, signature: 'b1'.repeat(64) };
    expect((await post('bo', `/api/proposals/${P}/retirement`, { signature: bos })).status).toBe(200);
    /* RED WHEN: one seat's signature for a version replaces another's, or a second for the same version is kept beside the first. */
    const adasAgain = { ...adas, signature: 'a2'.repeat(64) };
    expect((await post('ada', `/api/proposals/${P}/retirement`, { signature: adasAgain })).status).toBe(200);
    const adasFor6 = { ...adas, signedFor: 6, signature: 'a3'.repeat(64) };
    expect((await post('ada', `/api/proposals/${P}/retirement`, { signature: adasFor6 })).status).toBe(200);
    expect(store.getProposal(P)!.retirementSignatures).toEqual([bos, adasAgain, adasFor6]);
    expect(sent.map((x) => x.circuit)).toEqual(['approve']);
    /* RED WHEN: a seat hands in a signature under another seat's key, with an approval or alone. */
    expect((await post('ada', `/api/proposals/${P}/retirement`, { signature: { ...bos, signature: 'c1'.repeat(64) } })).status).toBe(422);
    expect((await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN), retirement: bos })).status).toBe(422);
    expect(sent).toHaveLength(1);
    expect((await post('ada', `/api/proposals/${P}/retirement`, { signature: { ...adas, signature: 'zz' } })).status).toBe(400);
    /* RED WHEN: one seat handing in signature after signature crowds another seat's out, or is kept without end. */
    for (let v = 10; v < 20; v += 1) {
      expect((await post('bo', `/api/proposals/${P}/retirement`, { signature: { ...bos, signedFor: v, signature: 'b2'.repeat(64) } })).status).toBe(200);
    }
    const kept = store.getProposal(P)!.retirementSignatures!;
    expect(kept.filter((x) => x.publicKey === FILER.bo).map((x) => x.signedFor)).toEqual([16, 17, 18, 19]);
    expect(kept.filter((x) => x.publicKey === FILER.ada)).toEqual([adasAgain, adasFor6]);
    /* RED WHEN: an approval's signature is kept only after the approval was relayed, so a refused keep follows a counted approval. */
    refuseAtTheDoor = 'the chain refused it. Nothing was sent.';
    const adasFor7 = { ...adas, signedFor: 7, signature: 'a4'.repeat(64) };
    expect((await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN), retirement: adasFor7 })).status).toBe(422);
    expect(store.getProposal(P)!.retirementSignatures!.some((x) => x.signedFor === 7)).toBe(true);
    refuseAtTheDoor = null;
    /* RED WHEN: a withdrawn proposal still takes retirement signatures. */
    store.putProposal(proposal({ status: 'cancelled' }));
    expect((await post('ada', `/api/proposals/${P}/retirement`, { signature: adas })).status).toBe(422);
  });

  it('A VAULT\'S SPENDING POLICY AND THE APPROVALS A POLICY CHANGE NEEDS ARE CARRIED OUT BY THE SAME ROUTE, AS THEIR OWN CIRCUITS', async () => {
    for (const circuit of ['setPolicy', 'setPolicyBar']) {
      sent.length = 0;
      store.putProposal(proposal());
      /* Not on the chain: nothing to carry out, and nothing is sent. */
      expect((await post('ada', `/api/proposals/${P}/carry`, { tx: tx(circuit, CHAIN), circuit })).status, circuit).toBe(422);
      expect(sent, circuit).toEqual([]);
      open.set(CHAIN, 2);
      const r = await post('bo', `/api/proposals/${P}/carry`, { tx: tx(circuit, CHAIN), circuit });
      /* RED WHEN the route refuses a policy or its bar, or relays it as another circuit - a policy approved on devices is never set. */
      expect(r.status, circuit).toBe(200);
      expect(sent, circuit).toEqual([{ accountId: CO, circuit, proposal: CHAIN }]);
      /* RED WHEN a policy carried out is not written down as carried out once the chain closed it. */
      expect(r.body, circuit).toMatchObject({ status: 'executed' });
    }
  });

  it('AN APPROVED RUN CHARGED TO ITS PERIOD IS RELAYED AS clearRun, AND ITS PROPOSAL, STILL OPEN TO BE PAID, IS NOT WRITTEN DOWN AS CARRIED OUT', async () => {
    /* Not on the chain: nothing to charge. RED WHEN the route stops asking whether the chain holds it. */
    const notHeld = await post('ada', `/api/proposals/${P}/charge`, { tx: tx('clearRun', CHAIN) });
    expect(notHeld.status).toBe(422);
    expect(notHeld.body).toMatchObject({ nothingWasSent: true });
    expect(sent).toEqual([]);
    open.set(CHAIN, 2);
    const r = await post('bo', `/api/proposals/${P}/charge`, { tx: tx('clearRun', CHAIN) });
    /* RED WHEN the route relays it as any other call than clearRun. */
    expect(r.status).toBe(200);
    expect(sent).toEqual([{ accountId: CO, circuit: 'clearRun', proposal: CHAIN }]);
    /* RED WHEN a proposal the chain still holds open after the charge is written down as carried out, as /carry would. */
    expect(r.body).toMatchObject({ id: P, status: 'open', approvalCount: 2 });
    expect(store.getProposal(P)!.status).toBe('open');
    /* RED WHEN the route takes a circuit from the body: it relays clearRun and nothing else. */
    expect((await post('ada', `/api/proposals/${P}/charge`, { tx: tx('clearRun', CHAIN), circuit: 'setThreshold' })).status).toBe(400);
    /* RED WHEN a withdrawn, carried-out or stopped proposal is charged: its plain status is read before anything is sent. */
    for (const status of ['cancelled', 'executed', 'blocked'] as const) {
      store.putProposal(proposal({ status }));
      expect((await post('ada', `/api/proposals/${P}/charge`, { tx: tx('clearRun', CHAIN) })).status, status).toBe(422);
    }
    expect(sent).toHaveLength(1);
  });
});

describe('A PROPOSAL A SEAT\'S DEVICE WROTE DOWN IS FILED ONLY AS THAT SEAT SIGNED IT', () => {
  /* A change to the company is raised for no vault: its identity on the chain is made with the reserved one. */
  const SALT = '0a'.repeat(32);
  const VAULT = 'c5'.repeat(32);
  const filing = (id: string, digest = '33'.repeat(32), keyEpoch = 0, vault?: string): ProposalFiling => ({
    id, digest: digest as Hex, chainId: MidnightCommitments.proposalId(digest as Hex, SALT as Hex, vault as Hex | undefined),
    keyEpoch, createdAt: '2026-10-07T00:00:00.000Z', sealed: { iv: 'aa', tag: 'bb', body: 'cc' } as never,
  });

  it('FILED, AND ITS RAISE SENT, WHEN SIGNED BY THE SIGNED-IN PERSON\'S OWN DIRECTORY KEY', async () => {
    const f = signProposalFiling(CO, filing('prp_filedByAdaAA'), ADA.signingSecret as Hex);
    const r = await post('ada', `/api/accounts/${CO}/proposals`, { proposal: f, tx: tx('propose', f.chainId), version: DEVICE_RAISE_VERSION, salt: SALT });
    expect(r.status).toBe(200);
    expect(sent.map((x) => x.circuit)).toEqual(['propose']);
    /* RED WHEN the filer's signature is not kept with the proposal, for every device to check. */
    expect(store.getProposal('prp_filedByAdaAA')).toMatchObject({ accountId: CO, status: 'open', approvalCount: 0, filedBy: f.filedBy });
  });

  it('REFUSED WHEN SIGNED BY ANOTHER SEAT\'S KEY, CHANGED AFTER SIGNING, OR BESIDE AN OPEN ONE FOR THE SAME CHANGE, AND FILED AT ANY KEY EPOCH', async () => {
    const send = (who: string, p: unknown) => post(who, `/api/accounts/${CO}/proposals`, { proposal: p, salt: SALT });
    /* RED WHEN the filer's key is not held to the signed-in person's seat. */
    expect((await send('ada', signProposalFiling(CO, filing('prp_notYoursAAAA'), BO.signingSecret as Hex))).body.error).toMatch(/not your seat/u);
    /* RED WHEN the signature is not checked over the whole filing. */
    const tampered = { ...signProposalFiling(CO, filing('prp_tamperedAAAA'), ADA.signingSecret as Hex), digest: '55'.repeat(32) };
    expect((await send('ada', tampered)).body.error).toMatch(/signature does not cover/u);
    /*
     * The service judges no change of the company's key, so its own count of the key epoch refuses nothing.
     * RED WHEN a filing is refused for the key epoch it names.
     */
    const atAnotherEpoch = await send('ada', signProposalFiling(CO, filing('prp_oldEpochAAAA', '66'.repeat(32), 1), ADA.signingSecret as Hex));
    expect(atAnotherEpoch.status).toBe(200);
    expect(store.getProposal('prp_oldEpochAAAA')).toMatchObject({ keyEpoch: 1, status: 'open' });
    /* RED WHEN a second open proposal for the same change is filed beside the first. */
    expect((await send('ada', signProposalFiling(CO, filing('prp_besideAAAAAA', '11'.repeat(32)), ADA.signingSecret as Hex))).body.error)
      .toMatch(/already holds proposal prp_relayedAAAAA open/u);
    /* RED WHEN a member with no seat may write one down. */
    expect((await send('cy', signProposalFiling(CO, filing('prp_noSeatAAAAAA'), ADA.signingSecret as Hex))).status).toBe(422);
    for (const id of ['prp_notYoursAAAA', 'prp_tamperedAAAA', 'prp_besideAAAAAA', 'prp_noSeatAAAAAA']) expect(store.getProposal(id)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('A PAYROLL PROPOSAL, ONE WHOSE IDENTITY NAMES A VAULT OR THAT SAYS WHAT IT PAYS, IS NOT FILED WITHOUT THE RUN IT RAISES', async () => {
    const send = (p: unknown, more: Record<string, unknown> = {}) =>
      post('ada', `/api/accounts/${CO}/proposals`, { proposal: p, salt: SALT, tx: tx('propose', '44'.repeat(32)), version: DEVICE_RAISE_VERSION, ...more });
    /* RED WHEN a proposal raised for a vault is written down and its raise sent with no run naming it. */
    const forAVault = await send(signProposalFiling(CO, filing('prp_forAVaultAAA', '77'.repeat(32), 0, VAULT), ADA.signingSecret as Hex));
    expect(forAVault.status).toBe(422);
    expect(forAVault.body.error).toMatch(/only with the run it raises/u);
    /* RED WHEN a filing committing to payments is written down with no run. */
    const paying = await send(signProposalFiling(CO, { ...filing('prp_payingAAAAAA', '78'.repeat(32)), pays: '99'.repeat(32) as Hex }, ADA.signingSecret as Hex));
    expect(paying.body.error).toMatch(/only with the run it raises/u);
    /* RED WHEN the salt the identity is held to is not the one it was made with. */
    const otherSalt = await send(signProposalFiling(CO, filing('prp_otherSaltAAA', '79'.repeat(32)), ADA.signingSecret as Hex), { salt: '0b'.repeat(32) });
    expect(otherSalt.body.error).toMatch(/only with the run it raises/u);
    /* RED WHEN: a body that says what it pays is filed with no run, its payments asked of nobody. */
    const declaring = await send(signProposalFiling(CO, filing('prp_declaringAAA', '7a'.repeat(32)), ADA.signingSecret as Hex), {
      pays: { vault: VAULT, asset: '11'.repeat(32), payments: [{ kind: 'shielded', token: '11'.repeat(32), amount: '5' }] },
    });
    expect(declaring.body.error).toMatch(/only with the run it raises/u);
    for (const id of ['prp_forAVaultAAA', 'prp_payingAAAAAA', 'prp_otherSaltAAA', 'prp_declaringAAA']) expect(store.getProposal(id)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('A RUN NAMED FOR A VAULT THAT PAYS NOBODY IS WRITTEN DOWN ONLY WHEN ITS IDENTITY NAMES THAT VAULT', async () => {
    const send = (p: unknown, more: Record<string, unknown>) =>
      post('ada', `/api/accounts/${CO}/proposals`, { proposal: p, salt: SALT, ...more });
    const raised = (id: string, digest: string) => signProposalFiling(CO, filing(id, digest, 0, VAULT), ADA.signingSecret as Hex);
    /* RED WHEN: a new vault's first secret run, named for its vault and paying nobody, cannot be written down and raised. */
    const first = raised('prp_firstSecretA', '7b'.repeat(32));
    const ok = await send(first, { vault: VAULT, tx: tx('propose', first.chainId), version: DEVICE_RAISE_VERSION });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(sent).toEqual([{ accountId: CO, circuit: 'propose', proposal: first.chainId }]);
    expect(store.getProposal('prp_firstSecretA')).toMatchObject({ chainId: first.chainId, status: 'open', filedBy: first.filedBy });
    sent.length = 0;
    /* RED WHEN: the vault beside the filing is not held to the identity the filing signs. */
    const other = await send(raised('prp_otherVaultAA', '7c'.repeat(32)), { vault: 'c6'.repeat(32), tx: tx('propose', '44'.repeat(32)), version: DEVICE_RAISE_VERSION });
    expect(other.status).toBe(422);
    expect(other.body.error).toMatch(/not the vault its identity on the chain names/u);
    /* RED WHEN: a vault named beside the filing lets one that says what it pays, or comes with a run, past the payroll rule. */
    const paying = await send(signProposalFiling(CO, { ...filing('prp_payingVaultA', '7d'.repeat(32), 0, VAULT), pays: '99'.repeat(32) as Hex }, ADA.signingSecret as Hex), { vault: VAULT });
    expect(paying.status).toBe(422);
    const withARun = await send(raised('prp_withARunAAAA', '7e'.repeat(32)), { vault: VAULT, run: {} });
    expect(withARun.status).toBe(422);
    expect(withARun.body.error).toMatch(/names its vault in what it pays, never beside it/u);
    for (const id of ['prp_otherVaultAA', 'prp_payingVaultA', 'prp_withARunAAAA']) expect(store.getProposal(id)).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe('A RELAY IS PAID FOR THE SEAT WHOSE FILING KEY THE DEVICE SENDS, AMONG EVERY ENTRY ITS PERSON FILED', () => {
  /* Ada is seated a second time, and enters that seat under a new filing key. */
  const AGAIN = seatOf('ada', 11);
  const againKey = signingPublicKeyOf(AGAIN.signingSecret as Hex);
  /** The chain holding `seats` of Acme's, as the service reads it. */
  const holding = (seats: readonly string[]) => {
    const now = chains.get(CO)!;
    chains.set(CO, { ...now, seats: { ...now.seats, seats: [...seats] } });
  };
  beforeAll(async () => {
    holding([ADA.seat, BO.seat, AGAIN.seat]);
    const version = store.directoryFilingsOf(CO).length + 1;
    const r = await sendAs('ada')(`/api/accounts/${CO}/directory/${version}`, {
      method: 'POST', body: JSON.stringify({ company: CO, version, change: { kind: 'claim', entry: AGAIN.entry } }),
    });
    expect(r.status).toBe(201);
  });

  it('a person with two entries under two filing keys acts under the seat whose key their device sends', async () => {
    open.set(CHAIN, 0);
    /* The chain no longer holds Ada's first seat, and holds her second. */
    holding([BO.seat, AGAIN.seat]);
    /* RED WHEN the relay takes the person's first entry whatever key the device sends: its seat is not held, and nothing is relayed. */
    expect((await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN), filer: againKey })).status).toBe(200);
    /* And under the first entry's key, its seat not held, nothing is relayed. */
    expect((await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN), filer: ADA.statement.signingKey })).status).toBe(422);
    const SALT = '0a'.repeat(32);
    const digest = '3c'.repeat(32) as Hex;
    const f = signProposalFiling(CO, {
      id: 'prp_secondKeyAAA', digest, chainId: MidnightCommitments.proposalId(digest, SALT as Hex, undefined), keyEpoch: 0,
      createdAt: '2026-10-07T00:00:00.000Z', sealed: { iv: 'aa', tag: 'bb', body: 'cc' } as never,
    }, AGAIN.signingSecret as Hex);
    /* RED WHEN a proposal signed under the person's second filing key is refused as not their seat's. */
    const r = await post('ada', `/api/accounts/${CO}/proposals`, { proposal: f, tx: tx('propose', f.chainId), version: DEVICE_RAISE_VERSION, salt: SALT });
    expect(r.status).toBe(200);
    holding([ADA.seat, BO.seat, AGAIN.seat]);
  });

  it('a relay that carries no filing key is refused at its shape, and nothing is sent', async () => {
    open.set(CHAIN, 2);
    for (const [path, body] of [
      [`/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN) }],
      [`/api/proposals/${P}/cancel`, { tx: tx('cancel', CHAIN) }],
      [`/api/proposals/${P}/send`, { tx: tx('propose', CHAIN), version: DEVICE_RAISE_VERSION }],
      [`/api/proposals/${P}/carry`, { tx: tx('setThreshold', CHAIN), circuit: 'setThreshold' }],
      [`/api/proposals/${P}/charge`, { tx: tx('clearRun', CHAIN) }],
    ] as const) {
      /* RED WHEN a relay is paid for with no filing key, so its seat is found by person alone. */
      const r = await post('ada', path, { ...body, filer: undefined });
      expect(r.status, path).toBe(400);
      expect(r.body.nothingWasSent, path).toBe(true);
    }
    expect(sent).toEqual([]);
  });

  it('a filing key that is not one of that person\'s entries is refused, and nothing is sent', async () => {
    open.set(CHAIN, 0);
    /* RED WHEN the relay pays for a person under another person's filing key, or under a key no entry names. */
    for (const filer of [BO.statement.signingKey, 'cc'.repeat(32)]) {
      const r = await post('ada', `/api/proposals/${P}/approve`, { tx: tx('approve', CHAIN), filer });
      expect(r.status, filer).toBe(422);
      expect(r.body.error, filer).toMatch(/you hold no seat on this company/u);
    }
    expect(sent).toEqual([]);
  });
});

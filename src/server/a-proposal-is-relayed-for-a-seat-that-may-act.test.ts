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
import { aCompanyOfTwoSeats, store, CO, OTHER, ADA, BO, sendAs } from './a-company-of-two-seats.test-support.js';
import { proposalRelayRoutes } from './proposal-relays.js';
import { signProposalFiling, type ProposalFiling } from '../core/proposal-filing.js';
import { NothingWasSent } from '../core/jobs.js';
import { DEVICE_RAISE_VERSION } from '../core/device-raise.js';
import type { LedgerStatus } from '../core/ledger.js';
import type { SealedProposal } from '../core/types.js';
import type { Hex } from '../core/crypto.js';
import { MidnightCommitments } from '../midnight/commitments.js';

/* ── the chain, stood in ─────────────────────────────────────────────────── */

const open = new Map<string, number>();
let unreadable = false;
let refuseAtTheDoor: string | null = null;
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
    if (o.circuit !== circuit) throw new NothingWasSent(`the door was told ${circuit} and handed ${o.circuit}. Nothing was sent.`);
    sent.push({ accountId, circuit, proposal: o.proposal });
    if (circuit === 'propose') open.set(o.proposal, 0);
    else if (circuit === 'approve') open.set(o.proposal, (open.get(o.proposal) ?? 0) + 1);
    else open.delete(o.proposal);
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
  open.clear(); sent.length = 0; unreadable = false; refuseAtTheDoor = null;
  store.putProposal(proposal());
});

const post = (who: string | null, path: string, body: unknown) =>
  sendAs(who)(path, { method: 'POST', body: JSON.stringify(body) }) as Promise<{ status: number; body: any }>;

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

  it('REFUSED WHEN SIGNED BY ANOTHER SEAT\'S KEY, CHANGED AFTER SIGNING, AT ANOTHER KEY EPOCH, OR BESIDE AN OPEN ONE FOR THE SAME CHANGE', async () => {
    const send = (who: string, p: unknown) => post(who, `/api/accounts/${CO}/proposals`, { proposal: p, salt: SALT });
    /* RED WHEN the filer's key is not held to the signed-in person's seat. */
    expect((await send('ada', signProposalFiling(CO, filing('prp_notYoursAAAA'), BO.signingSecret as Hex))).body.error).toMatch(/not your seat/u);
    /* RED WHEN the signature is not checked over the whole filing. */
    const tampered = { ...signProposalFiling(CO, filing('prp_tamperedAAAA'), ADA.signingSecret as Hex), digest: '55'.repeat(32) };
    expect((await send('ada', tampered)).body.error).toMatch(/signature does not cover/u);
    /* RED WHEN a filing sealed under a key epoch the company no longer uses is filed. */
    expect((await send('ada', signProposalFiling(CO, filing('prp_oldEpochAAAA', '66'.repeat(32), 1), ADA.signingSecret as Hex))).body.error)
      .toMatch(/no longer uses/u);
    /* RED WHEN a second open proposal for the same change is filed beside the first. */
    expect((await send('ada', signProposalFiling(CO, filing('prp_besideAAAAAA', '11'.repeat(32)), ADA.signingSecret as Hex))).body.error)
      .toMatch(/already holds proposal prp_relayedAAAAA open/u);
    /* RED WHEN a member with no seat may write one down. */
    expect((await send('cy', signProposalFiling(CO, filing('prp_noSeatAAAAAA'), ADA.signingSecret as Hex))).status).toBe(422);
    for (const id of ['prp_notYoursAAAA', 'prp_tamperedAAAA', 'prp_oldEpochAAAA', 'prp_besideAAAAAA', 'prp_noSeatAAAAAA']) expect(store.getProposal(id)).toBeNull();
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
});


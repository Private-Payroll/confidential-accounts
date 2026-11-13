/**
 * **THE PROPOSAL RELAY ROUTES OVER A STAND-IN CHAIN, FOR THE TESTS THAT SEND THROUGH THEM.**
 *
 * Mounts the proposal routes (`proposal-relays.ts`) beside the directory and records routes of one company of two
 * seats (`a-company-of-two-seats`). The ledger is a stand-in: its door for a proven call reads which call and which
 * proposal a stand-in transaction carries and does to its open proposals what that call would, and its read of the
 * account answers from them. `chain` is what the stand-in answers, reset with one open proposal `P` before each test.
 * Importing this mounts the routes for the importing test file.
 */
import { beforeAll, beforeEach } from 'vitest';
import express from 'express';
import { aCompanyOfTwoSeats, store, CO, ADA, BO, EVE, sendAs } from './a-company-of-two-seats.test-support.js';
import { proposalRelayRoutes } from './proposal-relays.js';
import { NothingWasSent } from '../core/jobs.js';
import { FeeNotPaid } from '../midnight/sponsor.js';
import type { LedgerStatus } from '../core/ledger.js';
import type { SealedProposal } from '../core/types.js';
import type { ClosedOnChain } from './proposal-closed-on-chain.js';
import type { Hex } from '../core/crypto.js';
import { MidnightCommitments } from '../midnight/commitments.js';
import { adoptionRoundOf, firstSecretRunCarriedOf, type AccountStartPure } from '../midnight/vault-start.js';
import { pureCircuits } from '../../contracts/managed/contract/index.js';
import { pureCircuits as vaultPure } from '../../contracts/managed-vault/contract/index.js';

/* ── the chain, stood in ─────────────────────────────────────────────────── */

export const open = new Map<string, number>();
/* The vaults the company's account lists on the stand-in chain: those it adopted. */
export const adopted = new Set<string>();
/* The commitment of the secret each vault holds on the stand-in chain; a vault not named holds none. */
export const secrets = new Map<string, string>();
/* The vaults whose every sealed copy is written on the stand-in chain; the others are not started. */
export const started = new Set<string>();
/** What the stand-in chain answers, set by each test and reset before it. */
export const chain = {
  unreadable: false,
  refuseAtTheDoor: null as string | null,
  /** A fee the fee payer could not pay, refused before anything reached the chain. */
  feeNotPaid: false,
  /** The time of the newest block the stand-in indexer names, in milliseconds; null when it does not answer. */
  chainTime: null as number | null,
  /** How the stand-in account's history shows a proposal closed, or that it never held it. */
  history: 'never' as ClosedOnChain,
  /** The stand-in history behind the chain's own read: it has not yet seen the raise that read holds open. */
  historyBehind: false,
};
export const sent: Array<{ accountId: string; circuit: string; proposal: string }> = [];
export const tx = (circuit: string, proposal: string): string => Buffer.from(JSON.stringify({ circuit, proposal })).toString('base64');

export const ledger = {
  wiring: 'simulated' as const,
  status: async (): Promise<LedgerStatus | null> => (chain.unreadable ? null : {
    assets: [], openProposals: [...open].map(([id, approvals]) => ({ id: id as Hex, change: '00'.repeat(32) as Hex, approvals })),
    threshold: 2, vaultThresholds: [], signerCount: 2,
  } as unknown as LedgerStatus),
  submitProvenCall: async (accountId: string, bytes: Uint8Array, circuit: string) => {
    const o = JSON.parse(Buffer.from(bytes).toString('utf8')) as { circuit: string; proposal: string };
    if (chain.refuseAtTheDoor !== null) throw new NothingWasSent(chain.refuseAtTheDoor);
    if (chain.feeNotPaid) throw new FeeNotPaid('the fee for this call could not be paid just now. Nothing was sent.');
    if (o.circuit !== circuit) throw new NothingWasSent(`the door was told ${circuit} and handed ${o.circuit}. Nothing was sent.`);
    sent.push({ accountId, circuit, proposal: o.proposal });
    /* A raise counts its raiser, who here may approve on every vault, as the account's `propose` counts it. */
    if (circuit === 'propose') open.set(o.proposal, 1);
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
    adoptionOf: (vault, again) => adoptionRoundOf(pureCircuits as unknown as AccountStartPure, vault, again),
    vaultsAdopted: async () => (chain.unreadable ? null : [...adopted]),
    firstSecretRunOf: (vault, parts) => firstSecretRunCarriedOf({ vault: vaultPure as never, account: pureCircuits as never }, vault, parts),
    vaultSecretOf: async (vault) => (chain.unreadable ? null : { commitment: secrets.get(vault) ?? '00'.repeat(32), started: started.has(vault) }),
    closedOnChain: async (_accountId, chainId) => (open.has(chainId) && !chain.historyBehind ? 'open' : chain.history),
    chainTimeOf: async () => {
      if (chain.chainTime === null) throw new Error('the indexer did not answer');
      return chain.chainTime;
    },
  }));
});

beforeAll(() => {
  /* Cy is a member of Ada's company and holds no seat on it. */
  const acme = store.getAccount(CO)!;
  store.putAccount({ ...acme, memberUserIds: [...acme.memberUserIds, 'cy'] });
});

export const P = 'prp_relayedAAAAA';
export const CHAIN = '22'.repeat(32);
export const proposal = (over: Partial<SealedProposal> = {}): SealedProposal => ({
  id: P, accountId: CO, status: 'open', createdAt: '2026-10-07T00:00:00.000Z', digest: '11'.repeat(32) as Hex,
  chainId: CHAIN as Hex, approvalCount: 0, keyEpoch: 0, sealed: { iv: '', tag: '', body: '' } as never, ...over,
});

beforeEach(() => {
  open.clear(); adopted.clear(); secrets.clear(); started.clear(); sent.length = 0; chain.unreadable = false; chain.refuseAtTheDoor = null; chain.feeNotPaid = false;
  chain.chainTime = Date.parse(proposal().createdAt); chain.history = 'never'; chain.historyBehind = false;
  store.putProposal(proposal());
});

/** The filing key each person's device sends with a relay: its own seat's, or, for one with no seat here, a key no entry names. */
export const FILER: Readonly<Record<string, string>> = { ada: ADA.statement.signingKey, bo: BO.statement.signingKey, eve: EVE.statement.signingKey };
const RELAYS = /\/(approve|cancel|send|carry|charge|retirement|carried)$/u;
/** A request as the person's device sends it: a relay carries the device's filing key unless the body names its own. */
export const post = (who: string | null, path: string, body: unknown) => {
  const carried = RELAYS.test(path) && typeof body === 'object' && body !== null && !('filer' in body)
    ? { filer: FILER[who ?? ''] ?? 'cc'.repeat(32), ...body } : body;
  return sendAs(who)(path, { method: 'POST', body: JSON.stringify(carried) }) as Promise<{ status: number; body: any }>;
};

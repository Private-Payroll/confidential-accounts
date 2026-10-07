/**
 * **A COMPANY'S PROPOSALS ON THE PRODUCT'S SERVER: RELAYED, NEVER OPENED.**
 *
 * Raising a proposal, approving it, withdrawing it and carrying it out are each
 * a call to the company's account that opens with the contract's signer check,
 * so each is built and proved on a signer's own device with their own secret.
 * What reaches this server is the proven transaction. It holds no viewing key
 * and no signer's state, and it opens nothing; before it pays the fee for a call
 * it checks what it can without a key:
 *
 *   · the signed-in person is a member of the company the proposal is for, and
 *     holds a seat on it now that may act (`actingSeatOf`, check S);
 *   · the proposal is one that may take the call, as its plain status says;
 *   · the transaction is exactly one call, to the named circuit, on this
 *     company's own contract, moving no coin (the ledger's door for a proven
 *     call refuses anything else before anything is paid).
 *
 * The chain then makes its own checks - the signer, the proposal's identity,
 * one approval per signer - and decides. What is written here afterwards is
 * only what the chain was read to say: that it holds the proposal, how many
 * approvals it counts for it, that it withdrew it. Whether that count meets
 * the bar of the vault the proposal names is worked out on a signer's device,
 * which opens the record; the vault is sealed and this server never knows it.
 *
 * **EVERY ANSWER SAYS WHETHER ANYTHING WAS SENT.** `nothingWasSent: true` is a
 * refusal before the chain was handed anything, final and safe to say so;
 * `false` is a failure from the send onwards, which may have landed.
 */
import express from 'express';
import { z } from 'zod';
import type { Ledger, LedgerStatus } from '../core/ledger.js';
import type { SealedAccount, SealedProposal, SealedRun } from '../core/types.js';
import { runFilingRefusal, type SignedRunFiling } from '../core/run-filing.js';
import type { PaymentChecked } from '../core/device-raise.js';
import { paysCommitmentOf, proposalFilingRefusal, type SignedProposalFiling } from '../core/proposal-filing.js';
import { MAY_FILE } from '../midnight/seat-directory.js';
import { NothingWasSent, saysNothingWasSent } from '../core/jobs.js';
import { DEVICE_RAISE_VERSION, reloadThePage } from '../core/device-raise.js';
import {
  CANNOT_ASK_THE_CHAIN, chainHoldsIt, notSentBecauseItIs, RAISE_ON_ITS_WAY, standingOf, THE_CHAIN_ALREADY_HOLDS_IT,
  withTheChainsCount, type ProposalStanding,
} from '../core/proposal-standing.js';
import { ACTING_REFUSAL, actingSeatOf, type DirectorySeat } from '../midnight/seat-directory.js';
import { CHAIN_UNREAD, type DirectoryNow } from './seat-directory-route.js';

/** What these routes need of the service's store: the plain half of each proposal, and nothing sealed is read. */
export interface RelayStore {
  getProposal(id: string): SealedProposal | null;
  putProposal(p: SealedProposal): void;
  listProposals(accountId: string): SealedProposal[];
  getAccount(accountId: string): Pick<SealedAccount, 'id' | 'keyEpoch'> | null;
  getRun?(id: string): SealedRun | null;
  /** Writes the run only while the store still holds it exactly as `before`; false when it has moved on. */
  putRunIfStill?(r: SealedRun, before: SealedRun): boolean;
}

/**
 * **WHAT A RAISE OF A PAYROLL RUN ASKS OF THE VAULT'S PUBLIC MONEY.** A
 * device reads only a vault's private money; its public money is read here,
 * from the payments the device says the raise makes - a kind, a token and an
 * amount each, nothing about who is paid - and a raise the vault cannot pay is
 * refused before anything is written down.
 */
export type PublicMoneyCheck = (ask: {
  readonly vault: string; readonly asset: string; readonly payments: ReadonlyArray<PaymentChecked<string, string>>;
}) => Promise<void>;

/** What these routes need of the ledger: one read of the account, and the one door for a call a device proved. */
export type RelayLedger = Pick<Ledger, 'status' | 'wiring'> & Partial<Pick<Ledger, 'submitProvenCall'>>;

export interface ProposalRelayDeps {
  readonly signedIn: express.RequestHandler;
  /** The company named in the path has the signed-in person as a member. */
  readonly member: express.RequestHandler;
  /** The proposal named in the path is the company's of a member signed in. */
  readonly ownsProposal: express.RequestHandler;
  /** Refuses, by name, a body that still carries a signing secret. */
  readonly refuseSigningSecret: express.RequestHandler;
  readonly store: RelayStore;
  readonly ledger: RelayLedger;
  readonly directoryOf: (accountId: string) => Promise<DirectoryNow>;
  readonly recordRefusal: (method: string, path: string, status: number, kind: string, reason: string) => void;
  readonly now?: () => string;
  /** Present where a payroll run's raise is filed: the public money check above. */
  readonly publicMoney?: PublicMoneyCheck;
  /** The wiring a run filed with a raise is kept under. */
  readonly wiring?: () => SealedRun['wiring'];
  /**
   * The contract's own identity of a proposal: its payload, its salt and the
   * vault it is for, none naming the reserved "no vault" a change to the
   * company is raised for.
   */
  readonly proposalIdOf: (payloadHash: string, salt: string, vault?: string) => string;
}

/** A vault, an asset or a token: thirty-two bytes as sixty-four lower-case hexadecimal characters. */
const HEX64 = /^[0-9a-f]{64}$/u;

/** One proven transaction, as base64, held under the body limit. */
const TX = z.string().min(1).max(1_000_000);

/**
 * **A SEND IS ANSWERED WITH WHETHER ANYTHING WAS SENT.** A refusal before the
 * chain was handed the transaction is 422 and says nothing was sent; a failure
 * from the send onwards is 502 and may have landed.
 */
export async function answerASend(
  req: express.Request, res: express.Response, send: () => Promise<unknown>,
  recordRefusal: ProposalRelayDeps['recordRefusal'],
): Promise<void> {
  try {
    res.json(await send());
  } catch (e: any) {
    const nothing = saysNothingWasSent(e);
    const reason = e?.message ?? 'unknown error';
    recordRefusal(req.method, req.originalUrl, nothing ? 422 : 502, e?.name ?? 'Error', reason);
    res.status(nothing ? 422 : 502).json({ nothingWasSent: nothing, error: reason });
  }
}

/** A refusal before anything is sent is marked so, whatever threw it. */
const beforeSending = async <T>(check: () => Promise<T> | T): Promise<T> => {
  try {
    return await check();
  } catch (e) {
    if (saysNothingWasSent(e)) throw e;
    throw new NothingWasSent(`${String((e as { message?: unknown })?.message ?? e).replace(/\.\s*$/u, '')}. Nothing was sent.`);
  }
};

export const proposalRelayRoutes = (deps: ProposalRelayDeps): express.Router => {
  const router = express.Router();
  const json = express.json({ limit: '2mb' });
  const now = deps.now ?? (() => new Date().toISOString());
  /** Sends on their way, so a second request for the same one is refused rather than sent beside it. */
  const sending = new Set<string>();

  const requireProposal = (id: string): SealedProposal => {
    const p = deps.store.getProposal(id);
    if (p === null) throw new NothingWasSent('this company holds no proposal by that name. Nothing was sent.');
    return p;
  };

  /** The seat the signed-in person acts from on this company now, or a refusal that sent nothing. */
  const actingSeat = async (accountId: string, person: unknown): Promise<DirectorySeat> => {
    let now: DirectoryNow;
    try {
      now = await deps.directoryOf(accountId);
    } catch (e) {
      throw new NothingWasSent(`${CHAIN_UNREAD(e)}. Nothing was sent.`);
    }
    const seat = actingSeatOf(now.dir, now.chain?.seats ?? null, String(person));
    if (typeof seat === 'string') throw new NothingWasSent(`${ACTING_REFUSAL[seat]}. Nothing was sent.`);
    return seat;
  };

  /** The proposal as it is now with what `status` says of it, written down when that is news. */
  const written = (id: string, status: LedgerStatus | null): SealedProposal => {
    const latest = requireProposal(id);
    const next = withTheChainsCount(latest, status, now());
    if (next !== latest) deps.store.putProposal(next);
    return next;
  };

  /** The chain read once, a failure of it reading as no answer. */
  const readTheChain = async (accountId: string): Promise<LedgerStatus | null> => {
    try {
      return await deps.ledger.status(accountId);
    } catch {
      return null;
    }
  };

  /** The one door for a call a device proved; a deployment without it sent nothing. */
  const relay = async (accountId: string, tx: string, circuit: string, what: string) => {
    if (typeof deps.ledger.submitProvenCall !== 'function') {
      throw new NothingWasSent(`this deployment does not send transactions proved on a device, so ${what} was not sent. Nothing was sent.`);
    }
    return deps.ledger.submitProvenCall(accountId, new Uint8Array(Buffer.from(tx, 'base64')), circuit);
  };

  const held = (key: string, what: string): (() => void) => {
    if (sending.has(key)) {
      throw new NothingWasSent(`${what} is being sent from another request right now, so it was not sent again. Nothing was sent.`);
    }
    sending.add(key);
    return () => { sending.delete(key); };
  };

  /** A body that is not the one shape a route takes is refused as sending nothing. */
  const parsed = <T>(res: express.Response, schema: z.ZodType<T>, body: unknown, what: string): T | null => {
    const b = schema.safeParse(body ?? {});
    if (!b.success) {
      res.status(400).json({ nothingWasSent: true, error: `this request does not carry ${what}. Nothing was sent.` });
      return null;
    }
    return b.data;
  };

  /*
   * **ONE APPROVAL, AS A SIGNER'S DEVICE BUILT AND PROVED IT.** The device
   * proves the approval of a proposal it opened and, for a run, made again from
   * the company's records; the chain counts one approval per signer. What comes
   * back is where the proposal stands once the chain was read.
   */
  router.post('/api/proposals/:id/approve', deps.signedIn, json, deps.refuseSigningSecret, deps.ownsProposal, async (req, res) => {
    const b = parsed(res, z.object({ tx: TX }).strict(), req.body, 'an approval to send');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      const { proposal, release } = await beforeSending(async () => {
        const p = requireProposal(id);
        const seat = await actingSeat(p.accountId, (req as { userId?: unknown }).userId);
        if (p.status === 'executed') throw new NothingWasSent('this proposal has been carried out, so it takes no approvals. Nothing was sent.');
        if (p.status === 'blocked') throw new NothingWasSent('this company\'s own policy stopped this proposal, so it takes no approvals. Nothing was sent.');
        if (p.status === 'cancelled') {
          throw new NothingWasSent('this proposal was withdrawn, so it takes no approvals - including if it has since appeared on '
            + 'chain, because what replaced it may pay the same people. Nothing was sent.');
        }
        return { proposal: p, release: held(`approve ${id} ${seat.seat}`, 'this approval') };
      });
      try {
        await relay(proposal.accountId, b.tx, 'approve', 'this approval');
      } finally {
        release();
      }
      return standingOf(written(id, await readTheChain(proposal.accountId)));
    }, deps.recordRefusal);
  });

  /*
   * **WHERE A PROPOSAL STANDS ON THE CHAIN NOW, READ AND WRITTEN DOWN.** Sends
   * nothing. An approval is answered before the chain has counted it, so a
   * device asks here until it has.
   */
  router.post('/api/proposals/:id/standing', deps.signedIn, json, deps.ownsProposal, async (req, res) => {
    if (parsed(res, z.object({}).strict(), req.body, 'a question about a proposal') === null) return;
    const p = deps.store.getProposal(String(req.params.id))!;
    const answer: ProposalStanding = standingOf(written(p.id, await readTheChain(p.accountId)));
    res.json(answer);
  });

  /*
   * **A PROPOSAL WITHDRAWN.** One the chain holds is withdrawn by the call a
   * signer's device proved, and written down as withdrawn once the chain no
   * longer holds it. One only written down, never sent, is withdrawn here with
   * no call. One a device sent that the chain does not show yet is not: it may
   * still land, and a record closed here would sit beside an open proposal on
   * the chain nothing here can withdraw.
   */
  router.post('/api/proposals/:id/cancel', deps.signedIn, json, deps.ownsProposal, async (req, res) => {
    const b = parsed(res, z.object({ tx: TX.optional() }).strict(), req.body, 'a withdrawal');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      const { proposal, hold } = await beforeSending(async () => {
        const p = requireProposal(id);
        await actingSeat(p.accountId, (req as { userId?: unknown }).userId);
        if (p.status === 'executed') throw new Error('this proposal has been carried out, so there is nothing to withdraw');
        if (p.status === 'cancelled') throw new Error('this proposal is already withdrawn');
        const status = p.status === 'blocked' ? null : await readTheChain(p.accountId);
        const h = p.status === 'blocked' ? 'absent' : chainHoldsIt(p, status);
        if (h === 'unknown') throw new Error(CANNOT_ASK_THE_CHAIN);
        if (h === 'absent' && p.txRef && !p.raisedAt) {
          throw new Error(`this proposal was sent from a device, as ${p.txRef}, and the chain does not show it yet, so it may `
            + 'still arrive. Send it to the chain again from a signer\'s device - it is the same proposal, and the chain takes '
            + 'it once - or withdraw it once the chain shows it');
        }
        if (h === 'absent' && sending.has(`send ${id}`)) throw new Error(RAISE_ON_ITS_WAY.replace(/\.\s*$/u, ''));
        if (h === 'present' && b.tx === undefined) {
          throw new Error('the chain holds this proposal, so withdrawing it is a call a signer\'s device proves, and this '
            + 'request carries none');
        }
        if (h === 'absent' && b.tx !== undefined) {
          throw new Error('the chain does not hold this proposal, so there is no call to send: it is withdrawn without one');
        }
        return { proposal: p, hold: h };
      });
      if (hold === 'present') {
        const release = held(`cancel ${id}`, 'this withdrawal');
        try {
          await relay(proposal.accountId, b.tx!, 'cancel', 'this withdrawal');
        } finally {
          release();
        }
        const after = await readTheChain(proposal.accountId);
        const latest = requireProposal(id);
        if (after === null || chainHoldsIt({ chainId: latest.chainId }, after) !== 'absent') {
          return standingOf(written(id, after));
        }
        const closed: SealedProposal = { ...latest, status: 'cancelled' };
        deps.store.putProposal(closed);
        return standingOf(closed);
      }
      /* Only written down: read again with nothing awaited, so a send that started meanwhile is not closed over. */
      const latest = requireProposal(id);
      if (latest.txRef !== proposal.txRef || latest.raisedAt || sending.has(`send ${id}`)) {
        throw new NothingWasSent('this proposal was sent to the chain while it was being withdrawn, so it is not withdrawn here. '
          + 'Nothing was withdrawn. Try again, and the chain will be asked again.');
      }
      const closed: SealedProposal = { ...latest, status: 'cancelled' };
      deps.store.putProposal(closed);
      return standingOf(closed);
    }, deps.recordRefusal);
  });

  /*
   * **A PROPOSAL'S RAISE, AS A SIGNER'S DEVICE BUILT AND PROVED IT, SENT.** The
   * device made the raise from the company's own records and checked the
   * vault right before it; the page names the version that checks. Sent only
   * for a proposal written down, open and not seen on the chain; one a device
   * already sent is sent again only when the chain says it does not hold it.
   */
  /** A proposal's raise, sent once the person is known to act for its company: see the route below. */
  const sendTheRaise = async (id: string, tx: string): Promise<ProposalStanding> => {
    const { proposal, release } = await beforeSending(async () => {
      const p = requireProposal(id);
      if (p.status !== 'open') throw new NothingWasSent(notSentBecauseItIs(p.status));
      const h = p.raisedAt ? 'present' : p.txRef ? chainHoldsIt(p, await readTheChain(p.accountId)) : 'absent';
      if (h === 'present') throw new NothingWasSent(THE_CHAIN_ALREADY_HOLDS_IT);
      if (h === 'unknown') {
        throw new NothingWasSent(`this proposal was already sent from a device, as ${p.txRef}, and the chain did not answer `
          + 'whether it holds it. Sending it again now would be a guess. Nothing was sent. Try again once the chain answers.');
      }
      /* The last look, with nothing awaited between it and the hold. */
      const now2 = requireProposal(id);
      if (now2.status !== 'open' || now2.raisedAt || now2.txRef !== p.txRef) {
        throw new NothingWasSent('this proposal changed while the chain was being asked about it, so it was not sent. Nothing '
          + 'was sent. Reload the page and look at where it stands.');
      }
      return { proposal: now2, release: held(`send ${id}`, 'this proposal') };
    });
    try {
      const sent = await relay(proposal.accountId, tx, 'propose', 'this proposal');
      const fresh = requireProposal(id);
      deps.store.putProposal({ ...fresh, txRef: sent.ref });
    } finally {
      release();
    }
    return standingOf(written(id, await readTheChain(proposal.accountId)));
  };

  router.post('/api/proposals/:id/send', deps.signedIn, json, deps.ownsProposal, async (req, res) => {
    const b = parsed(res, z.object({ tx: TX, version: z.unknown().optional() }).strict(), req.body, 'a proposal to send');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      await beforeSending(async () => {
        if (b.version !== DEVICE_RAISE_VERSION) throw new NothingWasSent(reloadThePage(b.version, 'Nothing was sent.'));
        await actingSeat(requireProposal(id).accountId, (req as { userId?: unknown }).userId);
      });
      return sendTheRaise(id, b.tx);
    }, deps.recordRefusal);
  });

  /*
   * **AN APPROVED GOVERNANCE PROPOSAL CARRIED OUT**, by the call a signer's
   * device proved: a seat given, the company's threshold changed, or one vault's
   * own approvals needed changed. The chain checks the proposal is approved and
   * is for exactly that change, and closes it; it is written down as carried out
   * once the chain no longer holds it open.
   */
  router.post('/api/proposals/:id/carry', deps.signedIn, json, deps.ownsProposal, async (req, res) => {
    const b = parsed(res, z.object({ tx: TX, circuit: z.enum(['amendSigner', 'setThreshold', 'setVaultThreshold']) }).strict(),
      req.body, 'a change to carry out');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      const { proposal, release } = await beforeSending(async () => {
        const p = requireProposal(id);
        await actingSeat(p.accountId, (req as { userId?: unknown }).userId);
        if (p.status !== 'open' && p.status !== 'approved') throw new NothingWasSent(notSentBecauseItIs(p.status));
        const h = chainHoldsIt(p, p.raisedAt ? null : await readTheChain(p.accountId));
        if (h !== 'present') {
          throw new NothingWasSent('the chain does not hold this proposal open, so there is nothing to carry out. Nothing was sent.');
        }
        return { proposal: p, release: held(`carry ${id}`, 'carrying out this proposal') };
      });
      try {
        await relay(proposal.accountId, b.tx, b.circuit, 'carrying out this proposal');
      } finally {
        release();
      }
      const after = await readTheChain(proposal.accountId);
      const latest = requireProposal(id);
      if (after === null || after.openProposals.some((o) => o.id.toLowerCase() === latest.chainId.toLowerCase())) {
        return standingOf(written(id, after));
      }
      const carried: SealedProposal = { ...latest, status: 'executed', executedAt: now() };
      deps.store.putProposal(carried);
      return standingOf(carried);
    }, deps.recordRefusal);
  });

  /*
   * **A PROPOSAL A SIGNER'S DEVICE WROTE DOWN, FILED, AND ITS RAISE SENT.** The
   * device sealed it under the company's viewing key and signed the filing with
   * its seat's filing key; this files it only when that key is the one the
   * company's directory holds for the signed-in person's seat, whose role may
   * file a proposal (check S), at the company's key epoch now. A proposal the
   * company already holds open for the same change is not filed beside it: the
   * device raises that one instead.
   */
  /*
   * **A PAYROLL RUN RAISED FROM A DEVICE IS FILED WITH ITS PROPOSAL, OR NOT AT
   * ALL.** The run is re-filed signed by the same seat that signed the
   * proposal, whose role may file a run; it is the company's run kept here,
   * under the key it uses now, still unpaid, and the raise adds exactly this
   * proposal to the ones the run names, letting go only of a withdrawn one, and
   * it says what it pays.
   */
  const runRaisedWith = (
    company: string, filing: SignedProposalFiling, given: unknown,
    pays: { vault: string; asset: string; payments: Array<PaymentChecked<string, string>> } | undefined,
    seat: DirectorySeat, keyEpoch: number, salt: string,
  ): { run: SignedRunFiling; kept: SealedRun } => {
    const why = runFilingRefusal(company, given);
    if (why !== null) throw new NothingWasSent(`this is not a run this company can keep: ${why}. Nothing was written down or sent.`);
    const run = given as SignedRunFiling;
    if (run.filedBy.publicKey.toLowerCase() !== filing.filedBy.publicKey.toLowerCase()) {
      throw new NothingWasSent('this run and its proposal are signed by two different keys. Nothing was written down or sent.');
    }
    if (!MAY_FILE[seat.role ?? 'unset'].includes('run')) {
      throw new NothingWasSent('your seat on this company may not raise payroll runs. Nothing was written down or sent.');
    }
    if (deps.store.getRun === undefined || deps.store.putRunIfStill === undefined || deps.publicMoney === undefined) {
      throw new NothingWasSent('this service does not keep payroll runs raised from a device. Nothing was written down or sent.');
    }
    const kept = deps.store.getRun(run.id);
    if (kept === null || kept.accountId !== company) {
      throw new NothingWasSent('this company keeps no payroll run by that name. Nothing was written down or sent.');
    }
    if (run.keyEpoch !== keyEpoch || run.period !== kept.period) {
      throw new NothingWasSent('this run is not the run this company keeps under that name, under the key it uses now. Reload the '
        + 'page and raise it again. Nothing was written down or sent.');
    }
    if (kept.status === 'settled' || run.status !== 'proposed' || run.settledAt !== undefined) {
      throw new NothingWasSent('a run is raised while it is unpaid, and is kept as raised. Nothing was written down or sent.');
    }
    /* Only a withdrawn proposal, whose leg this raises again, may leave the run's list. */
    const before = new Set(kept.proposalIds ?? []);
    const after = new Set(run.proposalIds ?? []);
    const dropped = [...before].filter((id) => !after.has(id));
    const added = [...after].filter((id) => !before.has(id));
    if (added.length !== 1 || added[0] !== filing.id
      || dropped.some((id) => deps.store.getProposal(id)?.status !== 'cancelled')) {
      throw new NothingWasSent('this run does not add exactly this proposal to the ones it names. Nothing was written down or sent.');
    }
    if (pays === undefined) {
      throw new NothingWasSent('this raise does not say what it pays, so the vault cannot be checked for it. Nothing was written '
        + 'down or sent.');
    }
    /* What the vault is asked for is what the proposal itself commits to, from the vault its identity names. */
    if (filing.pays === undefined || paysCommitmentOf(pays, salt) !== filing.pays.toLowerCase()) {
      throw new NothingWasSent('what this raise says it pays is not what its proposal commits to paying, so the vault cannot be '
        + 'checked for it. Reload the page and raise it again. Nothing was written down or sent.');
    }
    if (deps.proposalIdOf(filing.digest, salt, pays.vault).toLowerCase() !== filing.chainId.toLowerCase()) {
      throw new NothingWasSent('the vault this raise says pays it is not the vault its proposal is raised for. Reload the page '
        + 'and raise it again. Nothing was written down or sent.');
    }
    return { run, kept };
  };

  router.post('/api/accounts/:id/proposals', deps.signedIn, deps.member, json, async (req, res) => {
    const b = parsed(res, z.object({
      proposal: z.unknown(), tx: TX.optional(), version: z.unknown().optional(),
      /* The proposal's salt: the service holds its identity on the chain to the vault it names, or to none. */
      salt: z.string().regex(HEX64),
      /* A payroll run's raise: the run re-filed with the raise, and what the raise pays, for the public money check. */
      run: z.unknown().optional(),
      pays: z.object({
        vault: z.string().regex(HEX64), asset: z.string().regex(HEX64),
        payments: z.array(z.object({ kind: z.enum(['shielded', 'unshielded']), token: z.string().regex(HEX64), amount: z.string().regex(/^[0-9]+$/u) }).strict()).min(1),
      }).strict().optional(),
    }).strict(), req.body, 'a proposal to write down');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const company = String(req.params.id);
      const filing = b.proposal as SignedProposalFiling;
      await beforeSending(async () => {
        if (b.tx !== undefined && b.version !== DEVICE_RAISE_VERSION) throw new NothingWasSent(reloadThePage(b.version, 'Nothing was sent.'));
        const why = proposalFilingRefusal(company, filing);
        if (why !== null) throw new NothingWasSent(`this is not a proposal this company can write down: ${why}. Nothing was written down or sent.`);
        const seat = await actingSeat(company, (req as { userId?: unknown }).userId);
        if (seat.signingKey !== filing.filedBy.publicKey.toLowerCase()) {
          throw new NothingWasSent('this proposal is signed by a key that is not your seat\'s in the company\'s directory. Nothing was written down or sent.');
        }
        if (!MAY_FILE[seat.role ?? 'unset'].includes('proposal')) {
          throw new NothingWasSent('your seat on this company may not raise proposals. Nothing was written down or sent.');
        }
        const account = deps.store.getAccount(company);
        if (account === null || filing.keyEpoch !== account.keyEpoch) {
          throw new NothingWasSent('this proposal is sealed under a key the company no longer uses. Reload the page and raise it '
            + 'again. Nothing was written down or sent.');
        }
        if (deps.store.getProposal(filing.id) !== null) {
          throw new NothingWasSent('a proposal by this name is already written down. Nothing was written down or sent.');
        }
        const live = deps.store.listProposals(company).find((p) => p.digest.toLowerCase() === filing.digest.toLowerCase()
          && (p.status === 'open' || p.status === 'approved'));
        if (live !== undefined) {
          throw new NothingWasSent(`this company already holds proposal ${live.id} open for the same change, so another is not `
            + 'written down beside it. Raise or approve that one. Nothing was written down or sent.');
        }
        /*
         * **A PROPOSAL FILED WITH NO RUN IS A CHANGE TO THE COMPANY**, raised for
         * no vault; one whose identity names a vault is a payroll proposal, filed
         * only with the run it raises.
         */
        if (b.run === undefined && (filing.pays !== undefined || b.pays !== undefined
          || deps.proposalIdOf(filing.digest, b.salt).toLowerCase() !== filing.chainId.toLowerCase())) {
          throw new NothingWasSent('a payroll proposal is written down only with the run it raises, and this one comes with none. '
            + 'Raise it from the run. Nothing was written down or sent.');
        }
        const raised = b.run === undefined ? undefined : runRaisedWith(company, filing, b.run, b.pays, seat, account.keyEpoch, b.salt);
        if (raised !== undefined) {
          await deps.publicMoney!({ vault: b.pays!.vault, asset: b.pays!.asset, payments: b.pays!.payments });
          /* Two raises of one run checked at once: the run is written only as it was read, and the second is refused. */
          /* And the proposal's name is still free: another raise, of another run, may have taken it meanwhile. */
          if (deps.store.getProposal(filing.id) !== null) {
            throw new NothingWasSent('a proposal by this name was written down while this one was checked. Nothing was written down or sent.');
          }
          if (!deps.store.putRunIfStill!({ ...raised.run, wiring: deps.wiring?.() ?? deps.ledger.wiring ?? null }, raised.kept)) {
            throw new NothingWasSent(`another raise of run ${raised.run.id} was written down while this one was checked, so this `
              + 'one was not. Reload the page to see the run as it is now. Nothing was written down or sent.');
          }
        }
        deps.store.putProposal({
          id: filing.id, accountId: company, status: 'open', createdAt: filing.createdAt, digest: filing.digest,
          chainId: filing.chainId, approvalCount: 0, keyEpoch: filing.keyEpoch, sealed: filing.sealed,
          filedBy: { publicKey: filing.filedBy.publicKey, signature: filing.filedBy.signature },
          ...(filing.pays === undefined ? {} : { pays: filing.pays }),
          wiring: deps.ledger.wiring ?? null,
        });
      });
      if (b.tx === undefined) return standingOf(requireProposal(filing.id));
      return sendTheRaise(filing.id, b.tx);
    }, deps.recordRefusal);
  });

  return router;
};

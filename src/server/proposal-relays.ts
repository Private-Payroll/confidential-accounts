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
 *     holds a seat on it the chain holds now (`actingSeatOf`); whether its role
 *     may raise or approve is each member's device's to judge as it reads;
 *   · the proposal is one that may take the call, as its plain status says;
 *   · the transaction is exactly one call, to the named circuit, on this
 *     company's own contract, moving no coin (the ledger's door for a proven
 *     call refuses anything else before anything is paid).
 *
 * The chain then makes its own checks - the signer, the proposal's identity,
 * one approval per signer - and decides. What is written here afterwards is
 * only what the chain was read to say: that it holds the proposal, how many
 * approvals it counts for it, that it withdrew it, or, for a vault's adoption
 * that the vault's own start step carried out, that the chain no longer holds
 * it open and lists the vault adopted. Whether that count meets
 * the bar of the vault the proposal names is worked out on a signer's device,
 * which opens the record; the vault is sealed in it and this server does not
 * read it. No raise hands this server a payment's amount, payee or currency.
 *
 * **EVERY ANSWER SAYS WHETHER ANYTHING WAS SENT.** `nothingWasSent: true` is a
 * refusal before the chain was handed anything, final and safe to say so, with
 * the fee's own code when the fee for the call could not be paid or the network
 * refused it (`feeAnswerCodeOf`); `false` is a failure from the send onwards,
 * which may have landed.
 */
import express from 'express';
import { z } from 'zod';
import type { Ledger, LedgerStatus } from '../core/ledger.js';
import type { Invite, SealedAccount, SealedProposal, SealedRun } from '../core/types.js';
import { runFilingRefusal, type SignedRunFiling } from '../core/run-filing.js';
import { proposalFilingRefusal, type SignedProposalFiling } from '../core/proposal-filing.js';
import { NothingWasSent, saysNothingWasSent } from '../core/jobs.js';
import { feeAnswerCodeOf } from '../midnight/sponsor.js';
import { DEVICE_RAISE_VERSION, reloadThePage } from '../core/device-raise.js';
import {
  CANNOT_ASK_THE_CHAIN, chainHoldsIt, notSentBecauseItIs, RAISE_ON_ITS_WAY, standingOf, THE_CHAIN_ALREADY_HOLDS_IT,
  withTheChainsCount, type ProposalStanding,
} from '../core/proposal-standing.js';
import { ACTING_REFUSAL, actingSeatOf, type DirectorySeat } from '../midnight/seat-directory.js';
import { CHAIN_UNREAD, type DirectoryNow } from './seat-directory-route.js';
import type { Hex } from '../core/crypto.js';
import { acceptsTheInvitation } from '../core/invitation.js';

/** What these routes need of the service's store: the plain half of each proposal, and nothing sealed is read. */
export interface RelayStore {
  getProposal(id: string): SealedProposal | null;
  putProposal(p: SealedProposal): void;
  listProposals(accountId: string): SealedProposal[];
  getAccount(accountId: string): Pick<SealedAccount, 'id'> | null;
  getRun?(id: string): SealedRun | null;
  /** An invitation by its id: what the seat an invitation offered is taken under. */
  invitationById?(id: string): Pick<Invite, 'kind' | 'accountId' | 'acceptanceHash' | 'revokedAt'> | null;
  /**
   * Writes a raised run and its proposal in one write, only while the store
   * still holds the run exactly as `before` and the proposal's name is free;
   * false, with nothing written, otherwise.
   */
  putRaisedRunAndProposal?(r: SealedRun, before: SealedRun, p: SealedProposal): boolean;
}

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
  /** The wiring a run filed with a raise is kept under. */
  readonly wiring?: () => SealedRun['wiring'];
  /**
   * The contract's own identity of a proposal: its payload, its salt and the
   * vault it is for, none naming the reserved "no vault" a change to the
   * company is raised for.
   */
  readonly proposalIdOf: (payloadHash: string, salt: string, vault?: string) => string;
  /** A vault's adoption proposal, its identity and payload, as the account's own functions make it (`adoptionRoundOf`). */
  readonly adoptionOf?: (vault: Hex) => { readonly proposal: string; readonly payload: string };
  /** The vaults the company's account lists on the chain now: the ones it adopted. Null when the chain did not answer. */
  readonly vaultsAdopted?: (accountId: string) => Promise<readonly string[] | null>;
}

/** A vault, an asset or a token: thirty-two bytes as sixty-four lower-case hexadecimal characters. */
const HEX64 = /^[0-9a-f]{64}$/u;
/** The filing key of the seat a device acts from, which it sends with every relay: the seat is found by its person and this key. */
const FILER = z.string().regex(HEX64);

/** One proven transaction, as base64, held under the body limit. */
const TX = z.string().min(1).max(1_000_000);
/** One seat's signature over a removal's retirement: the directory version it was made over, the seat's filing key and the signature. */
const RETIREMENT_SIGNATURE = z.object({
  signedFor: z.number().int().min(1).max(1_000_000), publicKey: z.string().regex(HEX64), signature: z.string().regex(/^[0-9a-f]{128}$/u),
}).strict();
/**
 * The most directory versions one seat's retirement signatures are kept for, beside one proposal: its newest. One seat
 * signs again only when another change took the version it signed for, so a few cover every honest case, and no seat
 * can crowd out another's.
 */
const VERSIONS_KEPT_PER_SEAT = 4;

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
    const code = nothing ? feeAnswerCodeOf(e) : null;
    recordRefusal(req.method, req.originalUrl, nothing ? 422 : 502, e?.name ?? 'Error', reason);
    res.status(nothing ? 422 : 502).json({ nothingWasSent: nothing, error: reason, ...(code === null ? {} : { code }) });
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

  /**
   * The seat the signed-in person acts from on this company now - their entry under the filing key their device sent - or a
   * refusal that sent nothing. `noEntry` is the words for a key none of that person's entries names, where a route has its own.
   */
  const actingSeat = async (accountId: string, person: unknown, filer: string, noEntry?: string): Promise<DirectorySeat> => {
    let now: DirectoryNow;
    try {
      now = await deps.directoryOf(accountId);
    } catch (e) {
      throw new NothingWasSent(`${CHAIN_UNREAD(e)}. Nothing was sent.`);
    }
    const seat = actingSeatOf(now.dir, now.chain?.seats ?? null, String(person), filer as Hex);
    if (seat === 'no-entry' && noEntry !== undefined) throw new NothingWasSent(noEntry);
    if (typeof seat === 'string') throw new NothingWasSent(`${ACTING_REFUSAL[seat]}. Nothing was sent.`);
    return seat;
  };

  /**
   * **A RETIREMENT SIGNATURE KEPT BESIDE ITS PROPOSAL**, as the signed-in seat's device handed it in, under that seat's
   * own filing key - a seat this service's own read of the chain holds (`actingSeat`) - in place of any it handed in
   * for the same directory version, and only for that seat's newest few versions, so no seat can take another's
   * place. Kept and served as given: this service holds none of what the retirement says, so it judges no signature;
   * every device checks each one.
   */
  const keepRetirementSignature = (id: string, kept: z.infer<typeof RETIREMENT_SIGNATURE>): void => {
    const p = requireProposal(id);
    const all = [...(p.retirementSignatures ?? []).filter((x) => x.signedFor !== kept.signedFor || x.publicKey !== kept.publicKey),
      { ...kept, publicKey: kept.publicKey as Hex, signature: kept.signature as Hex }];
    const newest = all.filter((x) => x.publicKey === kept.publicKey).map((x) => x.signedFor).sort((a, b) => b - a).slice(0, VERSIONS_KEPT_PER_SEAT);
    deps.store.putProposal({ ...p, retirementSignatures: all.filter((x) => x.publicKey !== kept.publicKey || newest.includes(x.signedFor)) });
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
    const b = parsed(res, z.object({ tx: TX, filer: FILER, retirement: RETIREMENT_SIGNATURE.optional() }).strict(), req.body, 'an approval to send');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      const { proposal, release } = await beforeSending(async () => {
        const p = requireProposal(id);
        const seat = await actingSeat(p.accountId, (req as { userId?: unknown }).userId, b.filer);
        if (b.retirement !== undefined && b.retirement.publicKey !== b.filer) {
          throw new NothingWasSent('the retirement signature this approval carries is not under the key of the seat sending it. Nothing was sent.');
        }
        if (p.status === 'executed') throw new NothingWasSent('this proposal has been carried out, so it takes no approvals. Nothing was sent.');
        if (p.status === 'blocked') throw new NothingWasSent('this company\'s own policy stopped this proposal, so it takes no approvals. Nothing was sent.');
        if (p.status === 'cancelled') {
          throw new NothingWasSent('this proposal was withdrawn, so it takes no approvals - including if it has since appeared on '
            + 'chain, because what replaced it may pay the same people. Nothing was sent.');
        }
        /* Kept before the approval is relayed: an approval the chain counted is never answered as refused for its signature. */
        if (b.retirement !== undefined) keepRetirementSignature(id, b.retirement);
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
   * **A RETIREMENT SIGNED AGAIN, WITH NO APPROVAL SENT**: a seat whose approval
   * the chain already counts signs the removal's retirement over the directory
   * version that is next now, when the version its first signature named was
   * taken by another change. Kept beside the proposal, whatever its status: a
   * removal the chain carried out first still needs its retirement filed.
   */
  router.post('/api/proposals/:id/retirement', deps.signedIn, json, deps.ownsProposal, async (req, res) => {
    const b = parsed(res, z.object({ signature: RETIREMENT_SIGNATURE, filer: FILER }).strict(), req.body, 'a retirement signature');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      await beforeSending(async () => {
        const p = requireProposal(id);
        await actingSeat(p.accountId, (req as { userId?: unknown }).userId, b.filer);
        if (b.signature.publicKey !== b.filer) {
          throw new NothingWasSent('this retirement signature is not under the key of the seat sending it. Nothing was sent.');
        }
        if (p.status === 'cancelled') throw new NothingWasSent('this proposal was withdrawn, so its retirement is not signed. Nothing was sent.');
      });
      keepRetirementSignature(id, b.signature);
      return standingOf(requireProposal(id));
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
    const b = parsed(res, z.object({ tx: TX.optional(), filer: FILER }).strict(), req.body, 'a withdrawal');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      const { proposal, hold } = await beforeSending(async () => {
        const p = requireProposal(id);
        await actingSeat(p.accountId, (req as { userId?: unknown }).userId, b.filer);
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
    const b = parsed(res, z.object({ tx: TX, version: z.unknown().optional(), filer: FILER }).strict(), req.body, 'a proposal to send');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      await beforeSending(async () => {
        if (b.version !== DEVICE_RAISE_VERSION) throw new NothingWasSent(reloadThePage(b.version, 'Nothing was sent.'));
        await actingSeat(requireProposal(id).accountId, (req as { userId?: unknown }).userId, b.filer);
      });
      return sendTheRaise(id, b.tx);
    }, deps.recordRefusal);
  });

  /*
   * **AN APPROVED GOVERNANCE PROPOSAL CARRIED OUT**, by the call a signer's
   * device proved: a seat given, the company's threshold changed, one vault's
   * own approvals needed changed, a vault's spending policy set, or the approvals
   * a change to a spending policy needs changed. The chain checks the proposal is approved and
   * is for exactly that change, and closes it; it is written down as carried out
   * once the chain no longer holds it open.
   */
  /*
   * THE INVITEE'S OWN CALL TAKING THE SEAT AN INVITATION BY ADDRESS OFFERED, relayed for whoever holds the invitation's
   * acceptance. Not behind a seated signer: the invitee holds no seat until the chain carries this call, and is no member
   * of the company. The chain is what decides: `seatInvited` is refused there unless the proposal invites the address
   * the invitee's own coin key makes, with the seat's rights, approved at the seat bar. Only that circuit is relayed.
   */
  router.post('/api/invites/:id/seat', deps.signedIn, json, async (req, res) => {
    const b = parsed(res, z.object({ acceptance: z.string().regex(HEX64), tx: TX }).strict(), req.body, 'a seat taken by invitation');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      const { accountId, release } = await beforeSending(async () => {
        const invite = deps.store.invitationById?.(id) ?? null;
        if (invite === null || invite.kind !== 'signer' || !acceptsTheInvitation(b.acceptance, invite.acceptanceHash)) {
          throw new NothingWasSent('no invitation to a seat answers to this acceptance, so no seat was taken. Nothing was sent.');
        }
        if (invite.revokedAt) throw new NothingWasSent('this invitation was taken back, so its seat was not taken. Nothing was sent.');
        return { accountId: invite.accountId, release: held(`seat ${id}`, 'taking this seat') };
      });
      try {
        const sent = await relay(accountId, b.tx, 'seatInvited', 'taking this seat');
        return { sent: true, txRef: sent.ref };
      } finally {
        release();
      }
    }, deps.recordRefusal);
  });

  router.post('/api/proposals/:id/carry', deps.signedIn, json, deps.ownsProposal, async (req, res) => {
    const b = parsed(res, z.object({ tx: TX, circuit: z.enum(['amendSigner', 'setThreshold', 'setVaultThreshold', 'setPolicy', 'setPolicyBar']), filer: FILER }).strict(),
      req.body, 'a change to carry out');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      const { proposal, release } = await beforeSending(async () => {
        const p = requireProposal(id);
        await actingSeat(p.accountId, (req as { userId?: unknown }).userId, b.filer);
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
   * **AN APPROVED RUN CHARGED TO ITS VAULT'S PERIOD**, by the call a signer's
   * device proved: the device worked out the period's running total itself and
   * the chain checks it against its own commitment, with the run's approvals,
   * its window, its band and the period's limit. The run's proposal stays open
   * on the chain - it is charged, to be paid - so what is written here is only
   * where the chain was read to hold it.
   */
  /*
   * **A VAULT'S ADOPTION THE CHAIN CARRIED OUT IS WRITTEN DOWN AS CARRIED OUT**,
   * the one proposal another call - the vault's own start step - carries out.
   * Kept only for a seat that may act, for the adoption of the vault named, as
   * the account's own functions make its identity and payload (`adoptionOf`),
   * once this server's own read of the chain no longer holds it open and lists
   * that vault adopted by the company's account. A proposal the chain no longer
   * holds may have been carried out, withdrawn, or left to run out, so absence
   * alone writes nothing down: the vault must also be listed as adopted. Nothing
   * is sent. A device asks it once its own read shows the vault adopted, so each
   * refusal says the vault is not affected and what resolves it.
   */
  router.post('/api/proposals/:id/carried', deps.signedIn, json, deps.ownsProposal, async (req, res) => {
    const b = parsed(res, z.object({ vault: z.string().regex(HEX64), filer: FILER }).strict(), req.body, 'a vault\'s adoption carried out on the chain');
    if (b === null) return;
    const p = deps.store.getProposal(String(req.params.id))!;
    const refuse = (status: number, error: string) => { res.status(status).json({ nothingWasSent: true, error }); };
    try {
      await actingSeat(p.accountId, (req as { userId?: unknown }).userId, b.filer);
    } catch (e) {
      refuse(403, (e as Error).message);
      return;
    }
    if (p.status === 'executed') { res.json(standingOf(p)); return; }
    if (deps.adoptionOf === undefined || deps.vaultsAdopted === undefined) {
      refuse(409, 'this service cannot check which vaults the company adopted, so it does not mark the adoption done. The vault is not affected. '
        + 'Tell whoever runs this service');
      return;
    }
    const round = deps.adoptionOf(b.vault.toLowerCase() as Hex);
    if (round.proposal.toLowerCase() !== p.chainId.toLowerCase() || round.payload.toLowerCase() !== p.digest.toLowerCase()) {
      refuse(409, 'this proposal is not the adoption of that vault, so it is not marked done here. The vault is not affected');
      return;
    }
    if ((p.status !== 'open' && p.status !== 'approved') || !p.raisedAt) {
      refuse(409, p.raisedAt ? `this adoption is ${p.status} in the company's proposals, so it is not marked done. The vault is not affected`
        : 'the service has no record of this adoption being raised, so it does not mark it done. The vault is not affected. Tell whoever runs this service');
      return;
    }
    const [status, adopted] = await Promise.all([readTheChain(p.accountId), deps.vaultsAdopted(p.accountId).catch(() => null)]);
    if (status === null || adopted === null) {
      refuse(503, 'the service could not read the chain, so it does not mark the adoption done yet. The vault is not affected. Press again in a minute');
      return;
    }
    if (chainHoldsIt({ chainId: p.chainId }, status) !== 'absent') {
      refuse(409, 'the service\'s read of the chain still shows this adoption open, so it does not mark it done yet. The vault is not affected. Press again in a minute');
      return;
    }
    if (!adopted.some((v) => v.toLowerCase() === b.vault.toLowerCase())) {
      refuse(409, 'the service\'s read of the chain does not show this vault adopted yet, so it does not mark the adoption done. The vault is not affected. '
        + 'Press again in a minute');
      return;
    }
    const carried: SealedProposal = { ...p, status: 'executed', executedAt: now() };
    deps.store.putProposal(carried);
    res.json(standingOf(carried));
  });

  router.post('/api/proposals/:id/charge', deps.signedIn, json, deps.ownsProposal, async (req, res) => {
    const b = parsed(res, z.object({ tx: TX, filer: FILER }).strict(), req.body, 'a run to charge to its period');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const id = String(req.params.id);
      const { proposal, release } = await beforeSending(async () => {
        const p = requireProposal(id);
        await actingSeat(p.accountId, (req as { userId?: unknown }).userId, b.filer);
        if (p.status !== 'open' && p.status !== 'approved') throw new NothingWasSent(notSentBecauseItIs(p.status));
        const h = chainHoldsIt(p, p.raisedAt ? null : await readTheChain(p.accountId));
        if (h !== 'present') {
          throw new NothingWasSent('the chain does not hold this run\'s proposal open, so there is nothing to charge. Nothing was sent.');
        }
        return { proposal: p, release: held(`charge ${id}`, 'charging this run to its period') };
      });
      try {
        await relay(proposal.accountId, b.tx, 'clearRun', 'charging this run to its period');
      } finally {
        release();
      }
      return standingOf(written(id, await readTheChain(proposal.accountId)));
    }, deps.recordRefusal);
  });

  /*
   * **A PROPOSAL A SIGNER'S DEVICE WROTE DOWN, FILED, AND ITS RAISE SENT.** The
   * device sealed it under the company's viewing key and signed the filing with
   * its seat's filing key; this files it only when that key is the one the
   * company's directory holds for the signed-in person's seat, held now
   * (`actingSeatOf`). It judges no change of the company's key, so the key
   * epoch a filing names refuses nothing here. A proposal the
   * company already holds open for the same change is not filed beside it: the
   * device raises that one instead.
   */
  /*
   * **A PAYROLL RUN RAISED FROM A DEVICE IS FILED WITH ITS PROPOSAL, OR NOT AT
   * ALL.** The run is re-filed signed by the same seat that signed the
   * proposal; it is the company's run kept here, for the same period,
   * still unpaid, and the raise adds exactly this
   * proposal to the ones the run names, letting go only of a withdrawn one, and
   * its proposal carries a commitment to what it pays. What it pays is not sent
   * here: the vault's money, private and public, is checked on the raising
   * device, and the chain refuses a payment the vault cannot make.
   */
  const runRaisedWith = (
    company: string, filing: SignedProposalFiling, given: unknown,
  ): { run: SignedRunFiling; kept: SealedRun } => {
    const why = runFilingRefusal(company, given);
    if (why !== null) throw new NothingWasSent(`this is not a run this company can keep: ${why}. Nothing was written down or sent.`);
    const run = given as SignedRunFiling;
    if (run.filedBy.publicKey.toLowerCase() !== filing.filedBy.publicKey.toLowerCase()) {
      throw new NothingWasSent('this run and its proposal are signed by two different keys. Nothing was written down or sent.');
    }
    if (deps.store.getRun === undefined || deps.store.putRaisedRunAndProposal === undefined) {
      throw new NothingWasSent('this service does not keep payroll runs raised from a device. Nothing was written down or sent.');
    }
    const kept = deps.store.getRun(run.id);
    if (kept === null || kept.accountId !== company) {
      throw new NothingWasSent('this company keeps no payroll run by that name. Nothing was written down or sent.');
    }
    if (run.period !== kept.period) {
      throw new NothingWasSent('this run is not the run this company keeps under that name, for the period it keeps it for. Reload the '
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
    if (filing.pays === undefined) {
      throw new NothingWasSent('this run\'s proposal does not commit to what it pays, so no signer\'s device could hold it to the '
        + 'run. Reload the page and raise it again. Nothing was written down or sent.');
    }
    return { run, kept };
  };

  router.post('/api/accounts/:id/proposals', deps.signedIn, deps.member, json, async (req, res) => {
    const b = parsed(res, z.object({
      proposal: z.unknown(), tx: TX.optional(), version: z.unknown().optional(),
      /*
       * The proposal's salt: the service holds a change's or a vault's first secret run's identity on the chain to the
       * vault it names, or to none. A run's is not used here.
       */
      salt: z.string().regex(HEX64),
      /*
       * A payroll run's raise: the run re-filed with the raise, and nothing it pays. A body naming its payments is
       * refused as any body with a field this route does not take is.
       */
      run: z.unknown().optional(),
      vault: z.string().regex(HEX64).optional(),
    }).strict(), req.body, 'a proposal to write down');
    if (b === null) return;
    await answerASend(req, res, async () => {
      const company = String(req.params.id);
      const filing = b.proposal as SignedProposalFiling;
      await beforeSending(async () => {
        if (b.tx !== undefined && b.version !== DEVICE_RAISE_VERSION) throw new NothingWasSent(reloadThePage(b.version, 'Nothing was sent.'));
        const why = proposalFilingRefusal(company, filing);
        if (why !== null) throw new NothingWasSent(`this is not a proposal this company can write down: ${why}. Nothing was written down or sent.`);
        /* The seat whose filing key signed the proposal, among every entry the signed-in person filed. */
        await actingSeat(company, (req as { userId?: unknown }).userId, filing.filedBy.publicKey,
          'this proposal is signed by a key that is not your seat\'s in the company\'s directory. Nothing was written down or sent.');
        if (deps.store.getAccount(company) === null) {
          throw new NothingWasSent('this service holds no company by that name. Nothing was written down or sent.');
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
         * no vault, or a run of one payee raised for the vault `vault` names: a
         * new vault's first secret run, or a one-off payment from the vault,
         * whose payment is sealed in a record of the company's this route never
         * reads. This route keeps no run record for either. That vault is not
         * signed: it is held only to the identity the filing signs, so it shows
         * the filing is consistent, never that the vault is this company's, and
         * the kind inside the sealed envelope is the devices' to judge. Such a
         * proposal says nothing of what it pays; a payroll proposal, which does,
         * is filed only with the run it raises.
         */
        if (b.run !== undefined && b.vault !== undefined) {
          throw new NothingWasSent('a payroll proposal is written down with its run, and its vault is sealed in its records, never named beside it. Nothing was written down or sent.');
        }
        if (b.run === undefined && (filing.pays !== undefined
          || deps.proposalIdOf(filing.digest, b.salt, b.vault).toLowerCase() !== filing.chainId.toLowerCase())) {
          throw new NothingWasSent(filing.pays !== undefined
            ? 'a proposal that says what it pays is a payroll proposal, written down only with the run it raises, and this one '
              + 'comes with none. Raise it from the run. Nothing was written down or sent.'
            : 'this proposal\'s identity on the chain is not the one its parts, its salt and the vault it is written down for '
              + 'make. Reload the page and raise it again. Nothing was written down or sent.');
        }
        const raised = b.run === undefined ? undefined : runRaisedWith(company, filing, b.run);
        const proposal: SealedProposal = {
          id: filing.id, accountId: company, status: 'open', createdAt: filing.createdAt, digest: filing.digest,
          chainId: filing.chainId, approvalCount: 0, keyEpoch: filing.keyEpoch, sealed: filing.sealed,
          filedBy: { publicKey: filing.filedBy.publicKey, signature: filing.filedBy.signature },
          ...(filing.pays === undefined ? {} : { pays: filing.pays }),
          wiring: deps.ledger.wiring ?? null,
        };
        if (raised === undefined) {
          deps.store.putProposal(proposal);
          return;
        }
        /*
         * **THE RUN AND ITS PROPOSAL ARE WRITTEN IN ONE WRITE, OR NEITHER IS.**
         * Only while the run is as it was read - two raises of one run checked
         * at once, the second is refused - and while the proposal's name is
         * still free. The store's write holds both conditions itself.
         */
        if (deps.store.getProposal(filing.id) !== null) {
          throw new NothingWasSent('a proposal by this name was written down while this one was checked. Nothing was written down or sent.');
        }
        if (!deps.store.putRaisedRunAndProposal!({ ...raised.run, wiring: deps.wiring?.() ?? deps.ledger.wiring ?? null }, raised.kept, proposal)) {
          throw new NothingWasSent(`another raise of run ${raised.run.id} was written down while this one was checked, so this `
            + 'one was not. Reload the page to see the run as it is now. Nothing was written down or sent.');
        }
      });
      if (b.tx === undefined) return standingOf(requireProposal(filing.id));
      return sendTheRaise(filing.id, b.tx);
    }, deps.recordRefusal);
  });

  return router;
};

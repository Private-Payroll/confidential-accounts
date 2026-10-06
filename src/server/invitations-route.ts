/**
 * **INVITATIONS ON THE PRODUCT'S SERVER: KEPT, SERVED SEALED, AND ACCEPTED -
 * NONE OF IT OPENED HERE.**
 *
 * The inviting signer's device makes everything (`invitation.ts`): the token,
 * the offer sealed under a key only the link carries, and, for a payee, their
 * first person record. What this service keeps of an invitation is its lookup
 * id, the hash of what accepts it, the sealed offer, who it is for and when it
 * stops being acceptable. It checks what it can without a key:
 *
 *   · **making one**: the invitation is signed by the signed-in person's own
 *     seat in the company's directory, whose role may file an offer (check S);
 *     a payee's first person record goes through the same filing as every
 *     company record (`fileCompanyRecord`), signed by the same seat;
 *   · **reading one**: only by its lookup id, metered by who is asking, and
 *     answered with the ciphertext;
 *   · **accepting one**: only with the proof the link's token gives, whose
 *     hash is all this service holds, and only while it is open. What is
 *     handed over is sealed on the invitee's own device to the company's inbox
 *     key, and kept unopened.
 *
 * No route here takes a token, an offer key or a company key, and nothing
 * here decides who is paid or seated: that is the admitting and seating
 * devices' to decide.
 */
import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { Invite, SealedAccount } from '../core/types.js';
import {
  acceptsTheInvitation, INVITATION_LIFETIME_MS, INVITATION_REFUSAL, verifiedInvitationFiler, whyThisInvitationIsClosed,
  whyThisIsNotAnInvitation, type InvitationFiling, type InvitationRefusal,
} from '../core/invitation.js';
import { FILING_REFUSAL, filerSeatOf } from '../midnight/seat-directory.js';
import { CHAIN_UNREAD, filerSeatNow, type DirectoryNow } from './seat-directory-route.js';
import type { CompanyRecordStore } from '../midnight/sealed-record-wire.js';
import { fileCompanyRecord } from './company-records-route.js';

/** What these routes need of the service's store. */
export interface InvitationStore {
  getAccount(accountId: string): SealedAccount | null;
  putAccount(account: SealedAccount): void;
  invitationById(id: string): Invite | null;
  putInvite(invite: Invite): void;
  setHandover(key: string, handover: Invite['handover']): boolean;
}

type Answer = { status: number; body: Record<string, unknown> };

const SEALED = z.object({
  ephemeral: z.string().regex(/^[0-9a-f]{64}$/), iv: z.string().min(1), tag: z.string(), body: z.string().min(1),
}).strict();

export const invitationRoutes = (deps: {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: InvitationStore;
  readonly records: () => CompanyRecordStore;
  readonly directoryOf: (accountId: string) => Promise<DirectoryNow>;
  /**
   * Counts a look at an offer against whoever is asking, before anything is
   * looked up; true when it may go on, having answered the request itself
   * when it may not.
   */
  readonly meterOffer: (req: express.Request, res: express.Response) => Promise<boolean>;
  /** Writes a refusal down where every other refusal of this service is written, with the reason the person was given. */
  readonly recordRefusal: (method: string, path: string, status: number, kind: string, reason: string) => void;
}): express.Router => {
  const router = express.Router();
  const json = express.json({ limit: '1mb' });
  /** Every refusal one of these routes answers is written down, once, with its code and the sentence that was sent. */
  const logged: express.RequestHandler = (req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 400) {
        const b = (body ?? {}) as { refused?: unknown; error?: unknown };
        deps.recordRefusal(req.method, req.originalUrl, res.statusCode, typeof b.refused === 'string' ? b.refused : 'Error', String(b.error ?? ''));
      }
      return send(body);
    };
    next();
  };

  const closedAnswer = (closed: InvitationRefusal): Answer =>
    ({ status: closed === 'not-found' ? 404 : 410, body: { refused: closed, error: INVITATION_REFUSAL[closed] } });

  /** Why an invitation a device filed is not kept, or null when it may be. */
  const refused = async (company: string, person: string, invitation: InvitationFiling): Promise<Answer | null> => {
    const filer = verifiedInvitationFiler(invitation);
    if (filer === null) {
      return { status: 403, body: { refused: 'not-signed', error: 'an invitation is signed by the seat that makes it, over exactly what is filed, and this one is not. Nothing was filed.' } };
    }
    let now: DirectoryNow;
    try { now = await deps.directoryOf(company); } catch (e) { return { status: 503, body: { error: CHAIN_UNREAD(e) } }; }
    const seat = filerSeatNow(now, person, filer, 'offer');
    if (typeof seat === 'string') {
      return { status: 403, body: { refused: seat, error: `this invitation was not filed, because ${FILING_REFUSAL[seat]}.` } };
    }
    if (deps.store.invitationById(invitation.id) !== null) {
      return { status: 409, body: { refused: 'invitation-taken', error: 'an invitation is already filed under that link. Make the invitation again: a new one has a new link.' } };
    }
    return null;
  };

  /** The invitation as this service keeps it: what finds it, what accepts it, and the offer it cannot open. */
  const keep = (company: string, person: string, invitation: InvitationFiling): void => {
    const now = Date.now();
    deps.store.putInvite({
      token: invitation.id, accountId: company, kind: invitation.kind,
      createdAt: new Date(now).toISOString(), createdBy: person,
      expiresAt: new Date(now + INVITATION_LIFETIME_MS).toISOString(),
      ...(invitation.person === undefined ? {} : { subjectId: invitation.person }),
      offer: invitation.offer, acceptanceHash: invitation.acceptanceHash, handover: null,
    });
  };

  /** The invitation a request names and what accepts it, or why it may not be used. */
  const accepting = (req: express.Request, kind: 'employee' | 'signer', acceptance: string): Invite | Answer => {
    const invite = deps.store.invitationById(String(req.params.id));
    const closed = whyThisInvitationIsClosed(invite, kind, Date.now());
    if (closed !== null) return closedAnswer(closed);
    if (!acceptsTheInvitation(acceptance, invite!.acceptanceHash)) return { status: 403, body: { refused: 'not-accepted', error: INVITATION_REFUSAL['not-accepted'] } };
    return invite!;
  };
  const isAnswer = (x: Invite | Answer): x is Answer => 'status' in x && 'body' in x;

  /*
   * **A PAYEE INVITED.** Their first person record and the invitation for it,
   * both made on the inviting device and signed by the same seat; the record
   * is filed first, through the one company-record filing, and the invitation
   * only once it is.
   */
  router.post('/api/accounts/:id/people', logged, deps.signedIn, deps.member, json, async (req, res) => {
    const company = String(req.params.id);
    const person = (req as { userId?: unknown }).userId;
    const body = req.body as { person?: unknown; invitation?: unknown } | null;
    const invitation = body?.invitation as InvitationFiling | undefined;
    const why = whyThisIsNotAnInvitation(invitation, company);
    if (why !== null || invitation!.kind !== 'employee' || typeof person !== 'string') {
      res.status(400).json({ refused: 'not-an-invitation', error: `nothing was filed: ${why ?? 'a person is invited with a payee\'s invitation'}.` });
      return;
    }
    const no = await refused(company, person, invitation!);
    if (no !== null) { res.status(no.status).json(no.body); return; }
    const record = body?.person as { id?: unknown; version?: unknown } | null;
    if (record === null || typeof record !== 'object' || record.id !== invitation!.person || record.version !== 1) {
      res.status(400).json({ refused: 'not-a-new-person', error: 'an invitation is filed with the first version of the person it is for, and this one is not. Nothing was filed.' });
      return;
    }
    const filed = await fileCompanyRecord(
      { records: deps.records(), accountOf: (a) => deps.store.getAccount(a), directoryOf: deps.directoryOf },
      person, { company, kind: 'person', id: String(invitation!.person) }, 1, body!.person);
    if (filed.status !== 201) { res.status(filed.status).json(filed.body); return; }
    keep(company, person, invitation!);
    res.status(201).json({ filed: true, person: invitation!.person, invitation: invitation!.id });
  });

  /*
   * **A SIGNER INVITED.** The same filing with no person: who the seat is for,
   * its role and the secret its new keys are proved with are inside the offer.
   */
  router.post('/api/accounts/:id/invites/signer', logged, deps.signedIn, deps.member, json, async (req, res) => {
    const company = String(req.params.id);
    const person = (req as { userId?: unknown }).userId;
    const invitation = (req.body as { invitation?: unknown } | null)?.invitation as InvitationFiling | undefined;
    const why = whyThisIsNotAnInvitation(invitation, company);
    if (why !== null || invitation!.kind !== 'signer' || typeof person !== 'string') {
      res.status(400).json({ refused: 'not-an-invitation', error: `nothing was filed: ${why ?? 'a signer is invited with a signer\'s invitation'}.` });
      return;
    }
    const no = await refused(company, person, invitation!);
    if (no !== null) { res.status(no.status).json(no.body); return; }
    keep(company, person, invitation!);
    res.status(201).json({ filed: true, invitation: invitation!.id });
  });

  /*
   * **WHAT AN INVITEE IS BEING OFFERED, STILL SEALED.** Not `member`, and not
   * signed in: they may read it before they have an account, which is when a
   * person decides. The path names the invitation by its lookup id; the key
   * that opens the offer stays in the link's fragment; what goes back is the
   * ciphertext and when it stops being acceptable. Metered by who is asking,
   * before anything is looked up.
   */
  router.get('/api/invites/:id/offer', logged, async (req, res) => {
    if (!(await deps.meterOffer(req, res))) return;
    const invite = deps.store.invitationById(String(req.params.id));
    const closed = invite === null ? 'not-found' : whyThisInvitationIsClosed(invite, invite.kind, Date.now());
    if (closed !== null) { const a = closedAnswer(closed); res.status(a.status).json(a.body); return; }
    res.status(200).json({ kind: invite!.kind, offer: invite!.offer, expiresAt: invite!.expiresAt });
  });

  /*
   * **A PAYEE ACCEPTS.** Signed in. What they hand over is sealed on their own
   * device to the company's inbox key; a field that would carry it in the clear
   * is refused by name rather than ignored, so a sender is never left believing
   * it was read. **Who accepted is not written here**: an admitting device reads
   * who the payee is from what they handed over, not from this sign-in.
   */
  router.post('/api/invites/:id/accept-employee', logged, deps.signedIn, json, (req, res) => {
    for (const [field, what] of [['address', 'a receiving address'], ['wrappingPublicKey', 'a payslip key']] as const) {
      if (req.body && typeof req.body === 'object' && field in (req.body as object)) {
        res.status(400).json({
          refused: 'handover-in-the-clear', code: 'handover-in-the-clear',
          error: `this posts ${what} in the clear, and this route takes only what was sealed on the payee's own device to the company's inbox key, so the field is refused rather than ignored. Nothing was sent.`,
        });
        return;
      }
    }
    const b = z.object({ acceptance: z.string(), handover: SEALED }).strict().safeParse(req.body);
    if (!b.success) { res.status(400).json({ refused: 'not-an-acceptance', error: 'an acceptance is the proof the link gives and what was sealed on this device, and nothing else. Nothing was sent.' }); return; }
    const invite = accepting(req, 'employee', b.data.acceptance);
    if (isAnswer(invite)) { res.status(invite.status).json(invite.body); return; }
    deps.store.setHandover(invite.token, b.data.handover);
    deps.store.putInvite({ ...invite, acceptedAt: new Date().toISOString() });
    res.status(201).json({ accepted: true, person: invite.subjectId });
  });

  /*
   * **A SIGNER ACCEPTS, ENDING IN THE SEAT REQUEST EVERY WAY OF JOINING ENDS
   * IN.** Signed in, but not `member`: accepting is what makes you one. What is
   * waiting is the invitee's new public keys, their leaf, the proof of their
   * keys, and the name and role the offer gave them, sealed on their device to
   * the company's inbox key. Every signer's device checks the proof before it
   * seats anybody.
   */
  router.post('/api/invites/:id/accept-signer', logged, deps.signedIn, json, async (req, res) => {
    const b = z.object({ acceptance: z.string(), waiting: SEALED, for: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional() }).strict().safeParse(req.body);
    if (!b.success) { res.status(400).json({ refused: 'not-an-acceptance', error: 'an acceptance is the proof the link gives and what was sealed on this device, and nothing else. Nothing was sent.' }); return; }
    const invite = accepting(req, 'signer', b.data.acceptance);
    if (isAnswer(invite)) { res.status(invite.status).json(invite.body); return; }
    const signedIn = (req as { userId?: unknown }).userId as string;
    /*
     * **A SEAT REQUEST FOR SOMEBODY ELSE, FROM THE CODE THEY GAVE.** Only the
     * seat that made this invitation may accept it for the person a pasted code
     * names, and only while its role may invite: that is the person who pasted
     * the code. Anybody else accepts for themselves.
     */
    if (b.data.for !== undefined) {
      let now: DirectoryNow;
      try { now = await deps.directoryOf(invite.accountId); } catch (e) { res.status(503).json({ error: CHAIN_UNREAD(e) }); return; }
      /* The rule check S makes of the seat inviting, under the key its own entry names. */
      const seat = now.dir.seats.find((x) => x.person === signedIn);
      if (invite.createdBy !== signedIn || seat === undefined
        || typeof filerSeatOf(now.dir, now.chain?.seats ?? null, signedIn, seat.signingKey, 'offer') === 'string') {
        res.status(403).json({ refused: 'not-yours-to-accept-for', error: 'a seat request is filed for somebody else only by the seat that made the invitation for their code. Nothing was sent.' });
        return;
      }
    }
    const who = b.data.for ?? signedIn;
    const rec = deps.store.getAccount(invite.accountId);
    if (rec === null) { const a = closedAnswer('not-found'); res.status(a.status).json(a.body); return; }
    if (rec.memberUserIds.includes(who) || rec.pendingSigners.some((p) => p.userId === who)) {
      res.status(409).json({ refused: 'already-on-this-account', error: 'that person is already on this company, so this invitation is not theirs to accept. Nothing was sent.' });
      return;
    }
    const pending = { id: 'sgn_' + nanoid(10), userId: who, createdAt: new Date().toISOString(), sealed: b.data.waiting };
    deps.store.putAccount({ ...rec, pendingSigners: [...rec.pendingSigners, pending] });
    deps.store.putInvite({ ...invite, acceptedAt: pending.createdAt, subjectId: pending.id });
    res.status(201).json({ id: pending.id });
  });

  return router;
};

/**
 * **INVITATIONS ON THE PRODUCT'S SERVER: KEPT, SERVED SEALED, AND ACCEPTED -
 * NONE OF IT OPENED HERE.**
 *
 * The inviting signer's device makes everything (`invitation.ts`): the token,
 * the offer sealed under a key only the link carries, and, for an employee,
 * their first person record. What this service keeps of an invitation is its lookup
 * id, the hash of what accepts it, the sealed offer, who it is for and when it
 * stops being acceptable. It checks what it can without a key:
 *
 *   · **making one**, of an employee, a vendor or a signer, on one route: the
 *     invitation is signed by the signed-in person's own seat in the company's
 *     directory, held now (`filerSeatOf`); whether its role may invite is the
 *     inviting device's and each member's device's to judge, since this service
 *     holds no seat's role; the kind is all it learns of the offer. A super
 *     admin's invitation is refused: super admins are invited under the
 *     committee's own rules, not by a seat;
 *     an employee's first person record goes through the same filing as every
 *     company record (`fileCompanyRecord`), signed by the same seat; which
 *     company key it was made under is the devices' to judge, never this
 *     service's;
 *   · **reading one**: only by its lookup id, metered by who is asking, and
 *     answered with the ciphertext; the company it was made for is named only
 *     to whoever holds the proof the link gives, so an invitee's device can
 *     check the offer is for the company its seat request would go to;
 *   · **accepting one**: only with the proof the link's token gives, whose
 *     hash is all this service holds, and only while it is open. What is
 *     handed over is sealed on the invitee's own device to the company's inbox
 *     key, and kept unopened; every member's device refuses an answer sealed to
 *     an inbox older than the company's key in force unless that change of the
 *     key named it as waiting, whatever this service passes on;
 *   · **withdrawing somebody waiting for a seat**: only on a withdrawal signed
 *     by the filing key of a seat the chain holds now (`signerSeatNow`); the
 *     request is let go and its invitation's link reads as withdrawn, so the
 *     same person can accept a new invitation. Whether that seat's role may
 *     withdraw anybody is the signing device's to refuse; nothing here judges
 *     a role.
 *
 * No route here takes a token, an offer key or a company key, and nothing
 * here decides who is paid or seated: that is the admitting and seating
 * devices' to decide.
 */
import express from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { Invite, SealedAccount } from '../core/types.js';
import type { Hex } from '../core/crypto.js';
import {
  acceptsTheInvitation, alreadyOnTheCompany, INVITATION_LIFETIME_MS, INVITATION_REFUSAL, SUPER_ADMIN_INVITED_BY_THE_COMMITTEE, verifiedInvitationFiler, whyThisInvitationIsClosed,
  whyThisIsNotAnInvitation, withdrawalRefusal, type InvitationFiling, type InvitationKind, type InvitationRefusal, type WaitingSignerWithdrawal,
} from '../core/invitation.js';
import { FILING_REFUSAL, filerSeatOf } from '../midnight/seat-directory.js';
import { CHAIN_UNREAD, filerSeatNow, signerSeatNow, type DirectoryNow } from './seat-directory-route.js';
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

/*
 * The company record filed together with each kind's invitation, or null for a kind filed alone: an employee's
 * first person record, and a vendor's first vendor entry, so every device judges who filed it as it judges any record.
 */
const RECORD_FILED_WITH: { readonly [K in InvitationKind]: 'person' | 'vendor' | null } = {
  employee: 'person', vendor: 'vendor', signer: null, 'super-admin': null,
};

const KIND_SAID: { readonly [K in InvitationKind]: string } = {
  employee: 'an employee\'s', vendor: 'a vendor\'s', signer: 'a signer\'s', 'super-admin': 'a super admin\'s',
};

const HEX64_LOW = /^[0-9a-f]{64}$/;

const OLDER_KEY_REFUSAL = 'this invitation was made under an older key of the company than the one it holds now, so a seat request cannot be filed after it expired. Ask the person who invited you for a new invitation. Nothing was sent.';

/* The seat numbers a wallet tries for one company: each makes a leaf at the invitation's rights and one at all vaults. */
const MOST_SEAT_NUMBERS = 64;

const SEALED = z.object({
  ephemeral: z.string().regex(/^[0-9a-f]{64}$/), iv: z.string().min(1), tag: z.string(), body: z.string().min(1),
}).strict();

export const invitationRoutes = (deps: {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  readonly store: InvitationStore;
  readonly records: () => CompanyRecordStore;
  readonly directoryOf: (accountId: string, also?: readonly string[]) => Promise<DirectoryNow>;
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
    const seat = filerSeatNow(now, person, filer);
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
      createdAt: new Date(now).toISOString(), createdBy: person, createdByKey: verifiedInvitationFiler(invitation),
      expiresAt: new Date(now + INVITATION_LIFETIME_MS).toISOString(),
      ...(invitation.person === undefined ? {} : { subjectId: invitation.person }),
      offer: invitation.offer, acceptanceHash: invitation.acceptanceHash, handover: null, keyEpoch: invitation.keyEpoch,
    });
  };

  /** The invitation a request names and what accepts it, or why it may not be used. */
  const accepting = (req: express.Request, kinds: readonly InvitationKind[], acceptance: string): Invite | Answer => {
    const invite = deps.store.invitationById(String(req.params.id));
    const closed = whyThisInvitationIsClosed(invite, kinds, Date.now());
    if (closed !== null) return closedAnswer(closed);
    if (!acceptsTheInvitation(acceptance, invite!.acceptanceHash)) return { status: 403, body: { refused: 'not-accepted', error: INVITATION_REFUSAL['not-accepted'] } };
    return invite!;
  };
  const isAnswer = (x: object): x is Answer => 'status' in x && 'body' in x;

  /*
   * Opens an invitation for a seat request. One that expired still takes the request of a seat the chain already holds
   * and no directory entry names, since the seat was taken before it ended (`late` is then true); one withdrawn or used
   * never does, and neither does a request without that seat. The same sign-in asking again for the same seat is given
   * the id it had; a request for a seat is never refused because somebody else asked for it, and one made under an
   * older key of the company than it holds now is refused.
   */
  const acceptingSeatRequest = async (
    req: express.Request, acceptance: string, leaf: string | undefined, who: string,
  ): Promise<{ invite: Invite; late: boolean } | Answer> => {
    const invite = accepting(req, ['signer'], acceptance);
    if (!isAnswer(invite)) return { invite, late: false };
    const row = deps.store.invitationById(String(req.params.id));
    if (invite.body.refused !== 'expired' || leaf === undefined || row === null || row.kind !== 'signer' || row.revokedAt || row.acceptedAt
      || !acceptsTheInvitation(acceptance, row.acceptanceHash)) return invite;
    const earlier = row.lateSeatRequests?.find((r) => r.leaf === leaf && r.userId === who);
    if (earlier !== undefined) return { status: 201, body: { id: earlier.id } };
    const rec = deps.store.getAccount(row.accountId);
    if (rec !== null && (row.keyEpoch ?? 0) < rec.keyEpoch) return { status: 410, body: { refused: 'expired', error: OLDER_KEY_REFUSAL } };
    let now: DirectoryNow;
    try { now = await deps.directoryOf(row.accountId, [leaf]); } catch (e) { return { status: 503, body: { error: CHAIN_UNREAD(e) } }; }
    const held = (now.chain?.seats.seats ?? []).some((x) => x.toLowerCase() === leaf);
    const named = now.dir.seats.some((x) => x.seat.toLowerCase() === leaf);
    return held && !named ? { invite: row, late: true } : invite;
  };
  /*
   * The id a signer's own seat request on this invitation was given, when the same signed-in person asks again with
   * the link's proof and that request is still waiting: an answer that never reached their wallet is given again, and
   * nothing is filed twice. Expiry is not asked again: the request was made while the invitation was open.
   */
  const seatRequestAskedAgain = (req: express.Request, acceptance: string): string | null => {
    const invite = deps.store.invitationById(String(req.params.id));
    const signedIn = (req as { userId?: unknown }).userId;
    if (invite === null || invite.kind !== 'signer' || invite.revokedAt || !invite.acceptedAt || typeof invite.subjectId !== 'string') return null;
    if (typeof signedIn !== 'string' || !acceptsTheInvitation(acceptance, invite.acceptanceHash)) return null;
    const rec = deps.store.getAccount(invite.accountId);
    return rec !== null && rec.pendingSigners.some((p) => p.id === invite.subjectId && p.userId === signedIn) ? invite.subjectId : null;
  };

  /*
   * **AN INVITATION OF AN EMPLOYEE, A VENDOR OR A SIGNER IS FILED HERE.** Whatever
   * the kind, the invitation is checked the same way and kept the same way; a
   * super admin's is refused, since no seat invites a super admin. An
   * employee's is filed together with their first person record, and a vendor's
   * with their first vendor entry, made on the inviting device and signed by
   * the same seat: the record is filed first, through the one company-record
   * filing, and the invitation only once it is.
   * The other kinds are filed alone. `RECORD_FILED_WITH` is the one place that
   * says which record goes with which kind.
   */
  router.post('/api/accounts/:id/invites', logged, deps.signedIn, deps.member, json, async (req, res) => {
    const company = String(req.params.id);
    const person = (req as { userId?: unknown }).userId;
    const body = req.body as { person?: unknown; invitation?: unknown } | null;
    const invitation = body?.invitation as InvitationFiling | undefined;
    const why = whyThisIsNotAnInvitation(invitation, company);
    if (why !== null || typeof person !== 'string') {
      res.status(400).json({ refused: 'not-an-invitation', error: `nothing was filed: ${why ?? 'an invitation is filed by somebody signed in'}.` });
      return;
    }
    if (invitation!.kind === 'super-admin') {
      res.status(400).json({ refused: 'super-admin-by-the-committee', error: `nothing was filed: ${SUPER_ADMIN_INVITED_BY_THE_COMMITTEE}.` });
      return;
    }
    const recordKind = RECORD_FILED_WITH[invitation!.kind];
    if (recordKind === null && body?.person !== undefined) {
      res.status(400).json({ refused: 'not-an-invitation', error: `nothing was filed: ${KIND_SAID[invitation!.kind]} invitation is filed with no record beside it.` });
      return;
    }
    const no = await refused(company, person, invitation!);
    if (no !== null) { res.status(no.status).json(no.body); return; }
    if (recordKind !== null) {
      const record = body?.person as { id?: unknown; version?: unknown } | null;
      if (record === null || typeof record !== 'object' || record.id !== invitation!.person || record.version !== 1) {
        res.status(400).json({ refused: 'not-a-new-person', error: 'an invitation is filed with the first version of the person or vendor entry it is for, and this one is not. Nothing was filed.' });
        return;
      }
      const filed = await fileCompanyRecord(
        { records: deps.records(), accountOf: (a) => deps.store.getAccount(a), directoryOf: deps.directoryOf },
        person, { company, kind: recordKind, id: String(invitation!.person) }, 1, body!.person);
      if (filed.status !== 201) { res.status(filed.status).json(filed.body); return; }
    }
    keep(company, person, invitation!);
    res.status(201).json({ filed: true, invitation: invitation!.id, ...(invitation!.person === undefined ? {} : { person: invitation!.person }) });
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
    const closed = invite === null ? 'not-found' : whyThisInvitationIsClosed(invite, [invite.kind], Date.now());
    if (closed !== null) { const a = closedAnswer(closed); res.status(a.status).json(a.body); return; }
    res.status(200).json({ kind: invite!.kind, offer: invite!.offer, expiresAt: invite!.expiresAt });
  });

  /*
   * **THE COMPANY A SIGNER'S INVITATION WAS FILED TO**, asked with the proof
   * the link gives: its id, label and account as this service holds them. The
   * invitee's device refuses an offer naming another company before it makes
   * its leaf, so a seat request never goes to a company the offer did not name.
   * Without the proof a lookup id names no company.
   */
  router.post('/api/invites/:id/filed-to', logged, json, async (req, res) => {
    if (!(await deps.meterOffer(req, res))) return;
    const b = z.object({ acceptance: z.string() }).strict().safeParse(req.body);
    if (!b.success) {
      res.status(400).json({ refused: 'not-an-acceptance', error: 'this is asked with the proof the link gives, and nothing else.' });
      return;
    }
    const invite = accepting(req, ['signer'], b.data.acceptance);
    if (isAnswer(invite)) { res.status(invite.status).json(invite.body); return; }
    const rec = deps.store.getAccount(invite.accountId);
    res.status(200).json({
      company: rec === null ? null : { id: invite.accountId, label: rec.companyLabel ?? null, account: rec.contractAddress ?? null },
    });
  });

  /*
   * **A PAYEE ACCEPTS: AN EMPLOYEE OR A VENDOR**, only as the kind the invitation was filed as. Signed in. What they hand over is sealed on their own
   * device to the company's inbox key; a field that would carry it in the clear
   * is refused by name rather than ignored, so a sender is never left believing
   * it was read. **Who accepted is not written here**: an admitting device reads
   * who the payee is from what they handed over, not from this sign-in.
   */
  router.post('/api/invites/:id/accept-payee', logged, deps.signedIn, json, (req, res) => {
    for (const [field, what] of [['address', 'a receiving address'], ['wrappingPublicKey', 'a payslip key']] as const) {
      if (req.body && typeof req.body === 'object' && field in (req.body as object)) {
        res.status(400).json({
          refused: 'handover-in-the-clear', code: 'handover-in-the-clear',
          error: `this posts ${what} in the clear, and this route takes only what was sealed on the payee's own device to the company's inbox key, so the field is refused rather than ignored. Nothing was sent.`,
        });
        return;
      }
    }
    const b = z.object({ acceptance: z.string(), handover: SEALED, kind: z.enum(['employee', 'vendor']) }).strict().safeParse(req.body);
    if (!b.success) { res.status(400).json({ refused: 'not-an-acceptance', error: 'an acceptance is the proof the link gives, what was sealed on this device and whether it accepts as an employee or a vendor, and nothing else. Nothing was sent.' }); return; }
    /* Accepted only as the kind it was filed as, so a vendor's hand-over never waits on an employee's invitation, or the reverse. */
    const invite = accepting(req, [b.data.kind], b.data.acceptance);
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
    const b = z.object({ acceptance: z.string(), waiting: SEALED, for: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), leaf: z.string().regex(HEX64_LOW).optional() }).strict().safeParse(req.body);
    if (!b.success) { res.status(400).json({ refused: 'not-an-acceptance', error: 'an acceptance is the proof the link gives and what was sealed on this device, and nothing else. Nothing was sent.' }); return; }
    const again = b.data.for === undefined ? seatRequestAskedAgain(req, b.data.acceptance) : null;
    if (again !== null) { res.status(201).json({ id: again }); return; }
    const signedIn = (req as { userId?: unknown }).userId as string;
    const opened = await acceptingSeatRequest(req, b.data.acceptance, b.data.leaf, b.data.for ?? signedIn);
    if (isAnswer(opened)) { res.status(opened.status).json(opened.body); return; }
    const { invite, late } = opened;
    /*
     * **A SEAT REQUEST FOR SOMEBODY ELSE, FROM THE CODE THEY GAVE.** Only the
     * seat that made this invitation may accept it for the person a pasted code
     * names, while the account holds it: that is the person who pasted the
     * code. Anybody else accepts for themselves.
     */
    if (b.data.for !== undefined) {
      let now: DirectoryNow;
      try { now = await deps.directoryOf(invite.accountId); } catch (e) { res.status(503).json({ error: CHAIN_UNREAD(e) }); return; }
      /* The seat that made the invitation: its person and the filing key it signed the invitation with (`filerSeatOf`). */
      const key = invite.createdByKey;
      if (invite.createdBy !== signedIn || typeof key !== 'string'
        || typeof filerSeatOf(now.dir, now.chain?.seats ?? null, signedIn, key as Hex) === 'string') {
        res.status(403).json({ refused: 'not-yours-to-accept-for', error: 'a seat request is filed for somebody else only by the seat that made the invitation for their code. Nothing was sent.' });
        return;
      }
    }
    const who = b.data.for ?? signedIn;
    const rec = deps.store.getAccount(invite.accountId);
    if (rec === null) { const a = closedAnswer('not-found'); res.status(a.status).json(a.body); return; }
    if (alreadyOnTheCompany(rec, who)) {
      res.status(409).json({ refused: 'already-on-this-account', error: 'that person is already on this company, so this invitation is not theirs to accept. Nothing was sent.' });
      return;
    }
    const pending = { id: 'sgn_' + nanoid(10), userId: who, createdAt: new Date().toISOString(), sealed: b.data.waiting };
    deps.store.putAccount({ ...rec, pendingSigners: [...rec.pendingSigners, pending] });
    deps.store.putInvite(late
      ? { ...invite, subjectId: pending.id, lateSeatRequests: [...(invite.lateSeatRequests ?? []), { leaf: b.data.leaf!, userId: who, id: pending.id }] }
      : { ...invite, acceptedAt: pending.createdAt, subjectId: pending.id });
    res.status(201).json({ id: pending.id });
  });

  /*
   * Which of the leaves and signing keys a wallet asks about a directory entry of the company already names, retired
   * seats included: it answers for those asked and nothing else, so a wallet picks a seat number no entry holds.
   */
  router.post('/api/invites/:id/seats-named', logged, deps.signedIn, json, async (req, res) => {
    const list = (most: number) => z.array(z.string().regex(HEX64_LOW)).max(most);
    if (!(await deps.meterOffer(req, res))) return;
    const b = z.object({ acceptance: z.string(), leaves: list(2 * MOST_SEAT_NUMBERS), keys: list(MOST_SEAT_NUMBERS) }).strict().safeParse(req.body);
    if (!b.success) { res.status(400).json({ refused: 'not-a-question', error: 'this asks which of a bounded list of seats and keys the company already names, with the proof the link gives. Nothing was answered.' }); return; }
    const invite = accepting(req, ['signer'], b.data.acceptance);
    if (isAnswer(invite)) { res.status(invite.status).json(invite.body); return; }
    let now: DirectoryNow;
    try { now = await deps.directoryOf(invite.accountId); } catch (e) { res.status(503).json({ error: CHAIN_UNREAD(e) }); return; }
    const leaves = new Set(now.dir.seats.map((x) => x.seat.toLowerCase()));
    const keys = new Set(now.dir.seats.map((x) => x.signingKey.toLowerCase()));
    res.status(200).json({ leaves: b.data.leaves.filter((x) => leaves.has(x)), keys: b.data.keys.filter((x) => keys.has(x)) });
  });

  /*
   * **SOMEBODY WAITING FOR A SEAT, WITHDRAWN.** A store and a relay only: the
   * withdrawal is held to its shape, its signature, and a seat the chain holds
   * now for the key that signed it, whoever hands it in. The seat request it
   * names is let go, and the invitation it answered is marked withdrawn,
   * except that a request filed after its invitation closed is let go alone
   * and leaves the invitation open. A request whose leaf this service's read
   * of the chain shows seated is refused as seated, unless it was filed late.
   * Which leaf the sealed request is for is not this service's to see: the
   * signing device names it, and refuses while a proposal that could seat it
   * is open on the chain.
   */
  router.post('/api/accounts/:id/signers/:signerId/withdraw', logged, deps.signedIn, deps.member, json, async (req, res) => {
    const company = String(req.params.id);
    const withdrawal = (req.body as { withdrawal?: unknown } | null)?.withdrawal as WaitingSignerWithdrawal | undefined;
    const why = withdrawalRefusal(withdrawal, company);
    if (why !== null || withdrawal!.signerId !== String(req.params.signerId)) {
      res.status(403).json({ refused: 'not-signed', error: `nobody was withdrawn: ${why ?? 'the withdrawal names another seat request than this one'}.` });
      return;
    }
    let now: DirectoryNow;
    /* The withdrawal's leaf is asked of the chain beside every seat an entry names, so a seat nobody has claimed yet is still seen. */
    try { now = await deps.directoryOf(company, [withdrawal!.leaf]); } catch {
      res.status(503).json({ error: 'the network could not be read just now, so nobody was withdrawn. Reload the page and try again.' });
      return;
    }
    const seat = signerSeatNow(now, withdrawal!.signedBy);
    if (typeof seat === 'string') {
      res.status(403).json({ refused: seat, error: `nobody was withdrawn, because ${FILING_REFUSAL[seat]}.` });
      return;
    }
    /* A request whose leaf this service's read of the chain shows seated is admitted, never let go, unless it was filed late for that seat. */
    const rec = deps.store.getAccount(company);
    const invite = deps.store.invitationById(withdrawal!.invitation);
    const late = invite?.lateSeatRequests?.some((r) => r.id === withdrawal!.signerId) === true;
    if (!late && (now.chain?.seats.seats ?? []).some((x) => x.toLowerCase() === withdrawal!.leaf.toLowerCase())) {
      res.status(409).json({ refused: 'seated-on-the-chain', error: 'that person has already taken their seat on the network, so they cannot be withdrawn. Press Finish adding beside their name to add them. Nobody was withdrawn.' });
      return;
    }
    if (rec === null || !rec.pendingSigners.some((p) => p.id === withdrawal!.signerId)) {
      res.status(409).json({ refused: 'not-waiting', error: 'that person is not waiting for a seat on this company. Reload the page. Nobody was withdrawn.' });
      return;
    }
    if (invite === null || invite.accountId !== company || (invite.subjectId !== withdrawal!.signerId && !late)) {
      res.status(409).json({ refused: 'not-its-invitation', error: 'the withdrawal names another invitation than the one that seat request answered. Nobody was withdrawn. Reload the page and try again.' });
      return;
    }
    deps.store.putAccount({ ...rec, pendingSigners: rec.pendingSigners.filter((p) => p.id !== withdrawal!.signerId) });
    /* A request filed late is let go alone: the invitation stays open to the person it was made for. */
    if (late) deps.store.putInvite({ ...invite, lateSeatRequests: invite.lateSeatRequests!.filter((r) => r.id !== withdrawal!.signerId) });
    else if (!invite.revokedAt) deps.store.putInvite({ ...invite, revokedAt: new Date().toISOString() });
    res.status(200).json({ withdrawn: withdrawal!.signerId });
  });

  return router;
};

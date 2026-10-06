/**
 * **A COMPANY'S PEOPLE ON THE PRODUCT'S SERVER: READ AS THEIR SIGNED RECORDS,
 * AND CHANGED ONLY BY A SEAT'S DEVICE FILING THE NEXT VERSION.**
 *
 * Every change to a person - where they stand, being admitted after they
 * handed over where to pay them, a signer making themselves payable - is made,
 * sealed and signed on a seat's own device, which makes every check that needs
 * what is inside the seal (who handed it over, whether they are already
 * payable, whether their address can be paid). This server checks what it can
 * without a key and files the version through the one company-record filing
 * (`fileCompanyRecord`):
 *
 *   · the person is the company's (`ownsPerson`) and the signed-in person's
 *     seat in the company's directory signed the version (check S);
 *   · the plain fact the change is about says what the route is for: a person
 *     admitted, or one made payable from their own sign-in, stands active; a
 *     status change sets active or leaver;
 *   · a person is admitted only while something they handed over waits, and
 *     once they are, what waited is emptied and their offer is gone.
 *
 * The read hands back each person's newest record, sealed, with whether
 * something waits to be admitted for them - a yes or a no, never what it is.
 * Nothing here opens a person, and no request carries a key.
 */
import express from 'express';
import type { Invite, SealedAccount } from '../core/types.js';
import { toCompanyWire, type CompanyRecordStore, type PersonStanding, type SealedCompanyRecord } from '../midnight/sealed-record-wire.js';
import type { DirectoryNow } from './seat-directory-route.js';
import { fileCompanyRecord, type FilingAnswer } from './company-records-route.js';

/** What these routes need of the service's store. */
export interface PeopleRouteStore {
  getAccount(accountId: string): SealedAccount | null;
  peopleOf(accountId: string): SealedCompanyRecord[];
  newestPerson(id: string): SealedCompanyRecord | null;
  handoverFor(subjectId: string): Invite['handover'];
  listInvites(accountId: string): Invite[];
  putInvite(invite: Invite): void;
  setHandover(key: string, handover: Invite['handover']): boolean;
}

export const peopleRoutes = (deps: {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  /** The person named in the path is on a payroll the signed-in person is a member of. */
  readonly ownsPerson: express.RequestHandler;
  readonly store: PeopleRouteStore;
  readonly records: () => CompanyRecordStore;
  readonly directoryOf: (accountId: string) => Promise<DirectoryNow>;
}): express.Router => {
  const router = express.Router();
  const json = express.json({ limit: '1mb' });

  /** The version a body carries, filed as the person `id` of `company` when it says `allowed`; or why not. */
  const file = async (
    req: express.Request, company: string, id: string, allowed: readonly PersonStanding[], what: string, first = false,
  ): Promise<FilingAnswer> => {
    const message = (req.body as { person?: unknown } | null)?.person as { version?: unknown; body?: unknown } | undefined;
    let facts: unknown;
    try { facts = (JSON.parse(String(message?.body)) as SealedCompanyRecord).facts; } catch { facts = undefined; }
    const status = (facts as { status?: unknown } | undefined)?.status;
    if (!allowed.includes(status as PersonStanding)) {
      return { status: 422, body: { refused: 'not-this-change', error: `${what}, and the version filed does not say so. Nothing was filed.` } };
    }
    if (first !== (message?.version === 1)) {
      return { status: 422, body: { refused: first ? 'not-a-new-person' : 'not-a-change', error: first
        ? 'a person made payable from their own sign-in is a new person, filed as their first version. Nothing was filed.'
        : 'this changes a person already on the payroll, as the next version of their record. Nothing was filed.' } };
    }
    return fileCompanyRecord(
      { records: deps.records(), accountOf: (a) => deps.store.getAccount(a), directoryOf: deps.directoryOf },
      (req as { userId?: unknown }).userId, { company, kind: 'person', id }, message?.version, message);
  };

  /*
   * **THE PEOPLE, AS THEIR SEALED RECORDS.** Each person's newest version, and
   * whether something they handed over waits to be admitted. The device that
   * asked opens them and believes only versions a seat it believes filed.
   */
  router.get('/api/accounts/:id/people', deps.signedIn, deps.member, (req, res) => {
    const company = String(req.params.id);
    res.status(200).json({
      people: deps.store.peopleOf(company).map((r) => ({ filed: toCompanyWire(r), handedOver: deps.store.handoverFor(r.id) !== null })),
    });
  });

  /* **WHERE A PERSON STANDS**, changed on a seat's device: active, or a leaver. */
  router.post('/api/people/:id/status', deps.signedIn, deps.ownsPerson, json, async (req, res) => {
    const id = String(req.params.id);
    const company = deps.store.newestPerson(id)!.company;
    const answer = await file(req, company, id, ['active', 'leaver'], 'a status change makes a person active or a leaver');
    res.status(answer.status).json(answer.body);
  });

  /*
   * **A PERSON ADMITTED, AS THE ADMITTING DEVICE DECIDED IT.** That device
   * opened what they handed over and made every check on it; this files the
   * version it signed, only while something waits to be admitted, then empties
   * what waited and drops the offer, so neither is a second standing copy.
   */
  router.post('/api/employees/:id/admit', deps.signedIn, deps.ownsPerson, json, async (req, res) => {
    const id = String(req.params.id);
    const company = deps.store.newestPerson(id)!.company;
    if (deps.store.handoverFor(id) === null) {
      res.status(409).json({ refused: 'nothing-handed-over', error: 'nothing waits to be admitted for this person, so there is nothing to admit. Nothing was filed.' });
      return;
    }
    const answer = await file(req, company, id, ['active'], 'admitting a person makes them active');
    if (answer.status === 201) {
      for (const invite of deps.store.listInvites(company).filter((i) => i.subjectId === id)) {
        deps.store.setHandover(invite.token, null);
        if (invite.offer) deps.store.putInvite({ ...invite, offer: null });
      }
    }
    res.status(answer.status).json(answer.body);
  });

  /*
   * **A SIGNER MAKES THEMSELVES PAYABLE**, from their own device: their first
   * person record, active, carrying the code their own wallet signed for where
   * they are paid. No invitation, nobody else's sign-in, and nothing here reads
   * the address.
   */
  router.post('/api/accounts/:id/self-payee', deps.signedIn, deps.member, json, async (req, res) => {
    const company = String(req.params.id);
    const message = (req.body as { person?: unknown } | null)?.person as { id?: unknown } | undefined;
    if (typeof message?.id !== 'string') { res.status(400).json({ refused: 'not-a-person', error: 'nothing here is a person to file. Nothing was filed.' }); return; }
    const answer = await file(req, company, message.id, ['active'], 'a person made payable from their own sign-in stands active', true);
    res.status(answer.status).json(answer.body);
  });

  return router;
};

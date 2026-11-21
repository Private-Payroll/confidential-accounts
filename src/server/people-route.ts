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
 *     seat in the company's directory signed the version (`filerSeatOf`);
 *   · the plain fact the change is about says what the route is for: a person
 *     admitted, or one made payable from their own sign-in, stands active; a
 *     status change sets active or leaver; a change of their details (dates,
 *     salary, classification) leaves where they stand as it was;
 *   · a person is admitted only while something they handed over waits, and
 *     once they are, what waited is emptied and their offer is gone.
 *
 * A company's vendors are kept apart from its people and filed through the
 * company-record routes; what a vendor handed over is read, and their admission
 * filed, through the two vendor routes here, under the company's own address.
 *
 * The read hands back each person's newest record, sealed, with whether
 * something waits to be admitted for them - a yes or a no, never what it is.
 * What waits for many people is read in one request, each person checked as
 * this company's. Nothing here opens a person, and no request carries a key.
 */
import express from 'express';
import { z } from 'zod';
import type {} from './signed-in-request.js';
import type { Invite, SealedAccount } from '../core/types.js';
import type { InvitationKind } from '../core/invitation.js';
import {
  assertCompanyRecordId, toCompanyWire, type CompanyRecordStore, type PeopleRecords, type PersonStanding, type SealedCompanyRecord,
} from '../midnight/sealed-record-wire.js';
import type { DirectoryNow } from './seat-directory-route.js';
import { fileCompanyRecord, type FilingAnswer } from './company-records-route.js';
import { listAsked, READ_AT_ONCE, READ_BODY_LIMIT } from './read-at-once.js';

/** What these routes need of the service's store. */
export interface PeopleRouteStore {
  getAccount(accountId: string): SealedAccount | null;
  handoverFor(subjectId: string, kind: InvitationKind): Invite['handover'];
  listInvites(accountId: string): Invite[];
  putInvite(invite: Invite): void;
  setHandover(key: string, handover: Invite['handover']): boolean;
}

/**
 * The company whose records hold this person on its payroll, when the signed-in person is a member of that company;
 * `null` for anyone else. The one answer behind every read or change of one person: the gate on a person's own routes
 * (`ownsPersonBy`) and the read of many people's handovers.
 */
export type PersonHeldFor = (personId: string, userId: unknown) => Promise<string | null>;

/** `PersonHeldFor` over the company's people as their records hold them and the service's own answer to membership. */
export const personHeldIn = (
  people: () => PeopleRecords, isMember: (accountId: string, userId: string) => boolean,
): PersonHeldFor => async (personId, userId) => {
  const company = await people().companyOfPerson(personId);
  return company !== null && typeof userId === 'string' && isMember(company, userId) ? company : null;
};

const peopleUnread = (e: unknown) => ({ error: `the company's people could not be read: ${(e as Error)?.message ?? String(e)}` });

/**
 * **THE PERSON NAMED IN THE PATH IS ON THE PAYROLL OF A COMPANY THE SIGNED-IN
 * PERSON IS A MEMBER OF**, as `heldFor` answers it; anybody else is answered
 * 404, as if the person did not exist.
 */
export const ownsPersonBy = (heldFor: PersonHeldFor): express.RequestHandler => (req, res, next) => {
  heldFor(String(req.params.id), req.userId).then((company) => {
    if (company === null) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    next();
  }, (e: unknown) => {
    res.status(502).json(peopleUnread(e));
  });
};

/** What the people's routes are given: the gates, the company's stores and its directory. */
export interface PeopleRouteDeps {
  readonly signedIn: express.RequestHandler;
  readonly member: express.RequestHandler;
  /** The person named in the path is on a payroll the signed-in person is a member of. */
  readonly ownsPerson: express.RequestHandler;
  /** The answer `ownsPerson` stands behind, asked of each person a read of many names. */
  readonly heldFor: PersonHeldFor;
  readonly store: PeopleRouteStore;
  readonly records: () => CompanyRecordStore;
  /** The company's people, kept with its other records: the only copy of each. */
  readonly people: () => PeopleRecords;
  readonly directoryOf: (accountId: string) => Promise<DirectoryNow>;
}

export const peopleRoutes = (deps: PeopleRouteDeps): express.Router => {
  const router = express.Router();
  const json = express.json({ limit: '1mb' });
  /* What a person handed over, sealed, as every read of it answers: what one person's read and the list read hand back. */
  const handoverOf = (id: string) => ({ inbox: deps.store.handoverFor(id, 'employee') });

  /*
   * **THE PEOPLE, AS THEIR SEALED RECORDS.** Each person's newest version, and
   * whether something they handed over waits to be admitted. The device that
   * asked opens them and believes only versions a seat it believes filed.
   */
  router.get('/api/accounts/:id/people', deps.signedIn, deps.member, async (req, res) => {
    const company = String(req.params.id);
    let people: readonly SealedCompanyRecord[];
    try { people = await deps.people().peopleOf(company); } catch (e) {
      res.status(502).json({ error: `the company's people could not be read: ${(e as Error)?.message ?? String(e)}` });
      return;
    }
    res.status(200).json({
      people: people.map((r) => ({ filed: toCompanyWire(r), handedOver: deps.store.handoverFor(r.id, 'employee') !== null })),
    });
  });
  personChangeRoutes(router, deps, json);

  /**
   * **THE SEALED DROP BOX, FOR THE ADMIN'S OWN MACHINE TO OPEN.**
   *
   * The confirmation code is worked out on the ADMIN'S machine, because working it
   * out here would need the payee's address in the clear - so the browser needs
   * the ciphertext and this hands it over.
   *
   * **THIS ROUTE CANNOT READ WHAT IT SERVES.** The blob is sealed to the account's
   * inbox public key; the secret is derived from the account's viewing key, which
   * does not reach this handler on any path — there is no query parameter for one
   * and no body to put one in. **The rule is expressed as a missing parameter**,
   * the same way the accept door has nowhere to put a plain address.
   *
   * **AND IT IS NOT A WIDENING.** Everybody `ownsPerson` admits already holds the
   * viewing key that opens this — they need it to see the roster at all — and
   * nobody else can read it, including this deployment.
   */
  router.get('/api/employees/:id/handover', deps.signedIn, deps.ownsPerson, (req, res) => {
    res.json(handoverOf(String(req.params.id)));
  });
  const vendors = vendorHandoversIn(deps);
  manyHandoversRoute(router, deps, handoverOf, vendors.vendorHandoverOf);
  vendorRoutes(router, deps, json, vendors);
  return router;
};

/**
 * The version a body carries, filed as the person `id` of `company` when it says `allowed`; or why not. With
 * `keepsStanding`, the version must stand where the newest filed one does.
 */
const personFiledBy = (deps: PeopleRouteDeps) => async (
  req: express.Request, company: string, id: string, allowed: readonly PersonStanding[], what: string, first = false, keepsStanding = false,
): Promise<FilingAnswer> => {
  const message = (req.body as { person?: unknown } | null)?.person as { version?: unknown; body?: unknown } | undefined;
  let facts: unknown;
  try { facts = (JSON.parse(String(message?.body)) as SealedCompanyRecord).facts; } catch { facts = undefined; }
  const status = (facts as { status?: unknown } | undefined)?.status;
  if (!allowed.includes(status as PersonStanding)) {
    return { status: 422, body: { refused: 'not-this-change', error: `${what}, and the version filed does not say so. Nothing was filed.` } };
  }
  if (keepsStanding) {
    let newest: SealedCompanyRecord | null;
    try { newest = await deps.records().get(company, 'person', id); } catch (e) {
      return { status: 502, body: { error: `the person could not be read: ${(e as Error)?.message ?? String(e)}` } };
    }
    if (newest?.facts?.status !== status) {
      return { status: 422, body: { refused: 'not-this-change', error: `${what}, and the version filed does. Change where a person stands through their status. Nothing was filed.` } };
    }
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

/** The routes that change a person, each version filed signed on a seat's device. */
const personChangeRoutes = (router: express.Router, deps: PeopleRouteDeps, json: express.RequestHandler): void => {
  const file = personFiledBy(deps);
  /** The company whose payroll the person `id` is on; the person gate has already found them on one. */
  const companyOf = async (id: string): Promise<string> => (await deps.people().companyOfPerson(id))!;

  /* **WHERE A PERSON STANDS**, changed on a seat's device: active, or a leaver. */
  router.post('/api/people/:id/status', deps.signedIn, deps.ownsPerson, json, async (req, res) => {
    const id = String(req.params.id);
    const company = await companyOf(id);
    const answer = await file(req, company, id, ['active', 'leaver'], 'a status change makes a person active or a leaver');
    res.status(answer.status).json(answer.body);
  });

  /*
   * **A CHANGE OF A PERSON'S DETAILS**: a salary or classification line, an end
   * date or a leaving date, sealed and signed on a seat's device, which refused
   * any that would change a month already raised. Where the person stands is
   * not this route's to change.
   */
  router.post('/api/people/:id/details', deps.signedIn, deps.ownsPerson, json, async (req, res) => {
    const id = String(req.params.id);
    const company = await companyOf(id);
    const answer = await file(req, company, id, ['active', 'pending', 'leaver'], 'a change of details leaves where a person stands as it was', false, true);
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
    const company = await companyOf(id);
    if (deps.store.handoverFor(id, 'employee') === null) {
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
};

/** The vendors' hand-overs, as both reads of one answer them. */
const vendorHandoversIn = (deps: PeopleRouteDeps) => {
  /** The newest of the company's invitations of the vendor `vid` that something waits on, or undefined. */
  const vendorWaiting = (company: string, vid: string): Invite | undefined =>
    deps.store.listInvites(company).find((i) => i.subjectId === vid && i.kind === 'vendor' && i.handover);

  /** What the vendor `vid` handed over to `company`, sealed, as both reads of it answer; nothing for a vendor the company has not invited. */
  const vendorHandoverOf = (company: string, vid: string) => ({ inbox: vendorWaiting(company, vid)?.handover ?? null });
  return { vendorWaiting, vendorHandoverOf };
};

/** The read of what many people, or many vendors, handed over, in one request. */
const manyHandoversRoute = (
  router: express.Router, deps: PeopleRouteDeps, handoverOf: (id: string) => { readonly inbox: unknown },
  vendorHandoverOf: (company: string, vid: string) => { readonly inbox: unknown },
): void => {
  /*
   * **WHAT MANY PEOPLE HANDED OVER, SEALED, IN ONE REQUEST**: for each person named, in the order asked, what the read
   * of one person's handover answers. Every person is asked of `heldFor` as that read's gate asks it, and must be this
   * company's: one person who is not refuses the whole request, as if they did not exist, and nothing is read. A request
   * that names `vendors` instead is answered, vendor by vendor in the order asked, as the read of one vendor's handover
   * answers: what waits among this company's own invitations of that vendor, and nothing for a vendor it has not invited.
   */
  router.post('/api/accounts/:id/handovers', deps.signedIn, deps.member, express.json({ limit: READ_BODY_LIMIT }), async (req, res) => {
    const company = String(req.params.id);
    const vendors = listAsked(req.body, 'vendors', z.unknown());
    if (vendors !== null) {
      let named: readonly string[];
      try { named = vendors.map(assertCompanyRecordId); } catch (e) {
        res.status(400).json({ refused: 'not-a-list', error: `${(e as Error).message}. Name one to ${READ_AT_ONCE} of the company's vendors, each by their id. Nothing was read.` });
        return;
      }
      res.status(200).json({ handovers: named.map((vid) => vendorHandoverOf(company, vid)) });
      return;
    }
    let people: readonly string[];
    try {
      const asked = listAsked(req.body, 'people', z.unknown());
      if (asked === null) throw new Error('this is not a list of people');
      people = asked.map(assertCompanyRecordId);
    } catch (e) {
      res.status(400).json({ refused: 'not-a-list', error: `${(e as Error).message}. Name one to ${READ_AT_ONCE} of the company's people, each by their id. Nothing was read.` });
      return;
    }
    let held: readonly (string | null)[];
    try { held = await Promise.all([...new Set(people)].map((p) => deps.heldFor(p, req.userId))); } catch (e) {
      res.status(502).json(peopleUnread(e));
      return;
    }
    if (held.some((c) => c !== company)) {
      res.status(404).json({ refused: 'not-this-companys-person', error: 'a person named is not one of this company\'s people, so nothing was read. Ask only for the people on this company\'s payroll.' });
      return;
    }
    res.status(200).json({ handovers: people.map(handoverOf) });
  });
};

/** The routes of a vendor's hand-over: what waits, and their admission. */
const vendorRoutes = (
  router: express.Router, deps: PeopleRouteDeps, json: express.RequestHandler, { vendorWaiting, vendorHandoverOf }: ReturnType<typeof vendorHandoversIn>,
): void => {
  /*
   * **WHAT A VENDOR HANDED OVER, SEALED**, for the company's member whose device
   * admits them: only an invitation of this company's names it, so another
   * company's vendor is never read here.
   */
  router.get('/api/accounts/:id/vendors/:vid/handover', deps.signedIn, deps.member, (req, res) => {
    res.status(200).json(vendorHandoverOf(String(req.params.id), String(req.params.vid)));
  });

  /*
   * **A VENDOR ADMITTED**: the next version of their vendor entry, sealed and
   * signed on a seat's device that checked what they handed over. Filed only
   * while something they handed over waits; once it is, what waited is emptied
   * and their offer is gone.
   */
  router.post('/api/accounts/:id/vendors/:vid/admit', deps.signedIn, deps.member, json, async (req, res) => {
    const company = String(req.params.id);
    const vid = String(req.params.vid);
    if (vendorWaiting(company, vid) === undefined) {
      res.status(409).json({ refused: 'nothing-handed-over', error: 'nothing waits to be admitted for this vendor, so there is nothing to admit. Nothing was filed.' });
      return;
    }
    const message = (req.body as { vendor?: unknown } | null)?.vendor as { version?: unknown } | undefined;
    if (message?.version === 1) {
      res.status(422).json({ refused: 'not-a-change', error: 'admitting a vendor files the next version of their entry, not a first one. Nothing was filed.' });
      return;
    }
    const answer = await fileCompanyRecord(
      { records: deps.records(), accountOf: (a) => deps.store.getAccount(a), directoryOf: deps.directoryOf },
      (req as { userId?: unknown }).userId, { company, kind: 'vendor', id: vid }, message?.version, message);
    if (answer.status === 201) {
      for (const invite of deps.store.listInvites(company).filter((i) => i.subjectId === vid && i.kind === 'vendor')) {
        deps.store.setHandover(invite.token, null);
        if (invite.offer) deps.store.putInvite({ ...invite, offer: null });
      }
    }
    res.status(answer.status).json(answer.body);
  });
};
